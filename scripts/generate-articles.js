import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { countChineseChars, getCharLimits, shortenBodyIfNeeded } from "./article-validation.js";

const root = process.cwd();
const blogDir = path.join(root, "src", "blog");
const outputFile = path.join(root, ".generated-urls.json");
const MAX_ATTEMPTS = 5;
const STYLE = { id: "tutorial", name: "教程型", length: "750-2200字" };

const banned = [
  /seo/i,
  /关键词/g,
  /优化/g,
  /排名/g,
  /收录/g,
  /曝光/g,
  /综上所述/g,
  /毋庸置疑/g,
  /在当今数字化时代/g,
  /业界领先/g,
  /全方位/g,
  /深度融合/g,
  /极致/g
];

const tagPool = [
  "Windows客户端",
  "macOS客户端",
  "Android客户端",
  "iOS客户端",
  "节点切换",
  "线路选择",
  "连接排错",
  "多设备使用",
  "分流规则",
  "游戏加速",
  "流媒体",
  "校园网络"
];

function getCount() {
  const arg = process.argv.find((item) => item.startsWith("--count="));
  const raw = arg ? arg.split("=")[1] : process.env.GENERATE_COUNT || "1";
  const count = Number.parseInt(raw, 10);
  if (!Number.isInteger(count) || count < 1 || count > 9) {
    throw new Error("Count must be between 1 and 9.");
  }
  return count;
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function cleanText(input) {
  let text = String(input || "");
  for (const pattern of banned) text = text.replace(pattern, "");
  return text.trim();
}

function stripJsonFence(input) {
  return String(input || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseArticleJson(input) {
  const parsed = JSON.parse(stripJsonFence(input));
  return {
    title: cleanText(parsed.title),
    description: cleanText(parsed.description),
    category: cleanText(parsed.category),
    body: cleanText(parsed.body)
  };
}

function pickTags(seed) {
  const first = tagPool[seed % tagPool.length];
  const second = tagPool[(seed + 5) % tagPool.length];
  const third = tagPool[(seed + 9) % tagPool.length];
  return [...new Set([first, second, third])];
}

function hasVersionOrDate(text) {
  return /\d+\.\d+(\.\d+)?/.test(text) || /20\d{2}[-年/]\d{1,2}/.test(text) || /快连\s*\d/i.test(text);
}

function hasOperationSteps(text) {
  const stepMarkers =
    (text.match(/第[一二三四五六七八九十\d]+步/g) || []).length +
    (text.match(/^\s*\d+\.\s+/gm) || []).length;
  return stepMarkers >= 3;
}

function hasFaqSection(text) {
  return /##\s*常见问题/.test(text);
}

function hasFirstPerson(text) {
  return /我[^们]|上周|昨天|测试时|升级后/.test(text);
}

function validateArticle({ title, body }) {
  const issues = [];
  const { min: minChars, max: maxChars } = getCharLimits(STYLE);
  const charCount = countChineseChars(body);

  if (!title.startsWith("快连")) issues.push("标题必须以快连开头");
  if (/白皮书|完整指南|全面指南/.test(title)) issues.push("标题太官腔");
  if (charCount < minChars || charCount > maxChars) {
    issues.push(`正文字数 ${charCount}，应在 ${minChars}-${maxChars} 之间`);
  }
  if (!hasVersionOrDate(body)) issues.push("正文缺少具体版本号或日期");
  if (!hasOperationSteps(body)) issues.push("正文缺少至少 3 个操作步骤");
  if (!hasFaqSection(body)) issues.push("缺少「## 常见问题」小节");
  if (!hasFirstPerson(body)) issues.push("缺少第一人称叙述");
  return issues;
}

function frontMatter(data) {
  const tags = JSON.stringify(data.tags);
  let fm = `---\nlayout: article.njk\ntitle: ${data.title}\ndescription: ${data.description}\ndate: ${data.date}\ngenerated: true\ncategory: ${data.category}\ntags: ${tags}\nheroImage: "${data.heroImage}"\nheroAlt: "${data.heroAlt}"\n`;
  if (data.videoTitle) {
    fm += `videoTitle: "${data.videoTitle}"\nvideoDescription: "${data.videoDescription}"\nvideoPoster: "${data.videoPoster}"\n`;
  }
  fm += `---\n\n${data.body}\n`;
  return fm;
}

function buildPrompt(topic) {
  const { min: minChars, max: maxChars } = getCharLimits(STYLE);
  return [
    "Write one original Chinese markdown article for a normal Kuailian (快连) resource website.",
    "Return strict JSON only with fields: title, description, category, body.",
    "The title must start with 快连 and look like a personal technical blog title, not a white paper or official complete guide.",
    `Topic direction: ${topic}.`,
    `Body must use h2/h3 headings only, no h1. Chinese character count must be ${minChars}-${maxChars}.`,
    "Body must include one exact version number or date, at least 3 operation steps, a 常见问题 section, and at least one first-person paragraph such as 我测试时发现 or 上周升级后.",
    "Include one markdown image using /static/images/ path (no bing hotlink).",
    "Do not include external links, promotional claims, or words: seo, 关键词, 优化, 排名, 收录, 曝光, 综上所述, 毋庸置疑, 在当今数字化时代, 业界领先, 全方位, 深度融合, 极致."
  ].join("\n");
}

function buildPolishPrompt(draft) {
  const { min: minChars, max: maxChars } = getCharLimits(STYLE);
  return [
    "把下面文章改写成贴吧/知乎网友风格，输出 strict JSON only，字段仍然是 title, description, category, body。",
    "要求：缩短约20%官话，加1-2处自然口语，保留技术信息，随机替换部分连接词。",
    `正文中文字数必须 ${minChars}-${maxChars}，超出会被退回。`,
    "删掉「在当今」「随着…的快速发展」这类开头。",
    "标题像博客标题，不要出现「技术白皮书」「完整指南」这种官腔。",
    "正文必须包含：一个具体版本号或日期；至少3步操作步骤；一个「常见问题」小节；至少一段第一人称。",
    "正文只用 h2/h3，不要 h1。",
    "禁止用词：综上所述、毋庸置疑、在当今数字化时代、业界领先、全方位、深度融合、极致。",
    "输入 JSON：",
    JSON.stringify(draft)
  ].join("\n");
}

async function createArticle(ai, index) {
  const today = new Date();
  const date = today.toISOString().slice(0, 10);
  const seed = Math.floor(Date.now() / 1000) + index;
  const tags = pickTags(seed);
  const topic = tags.join("、");
  const { max: maxChars } = getCharLimits(STYLE);

  let lastIssues = [];
  let parsed = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const retryNote = attempt > 0 ? `\n\n上次不合格：${lastIssues.join("；")}。请修正后重新输出完整 JSON。` : "";
    const first = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: buildPrompt(topic) + retryNote
    });
    const firstDraft = parseArticleJson(first.text);
    const polished = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: buildPolishPrompt(firstDraft) + retryNote
    });
    parsed = parseArticleJson(polished.text);

    let title = parsed.title.startsWith("快连") ? parsed.title : `快连 ${parsed.title}`;
    let body = parsed.body;
    lastIssues = validateArticle({ title, body });

    if (lastIssues.length === 0) break;

    const onlyTooLong =
      lastIssues.length === 1 && lastIssues[0].includes("正文字数") && countChineseChars(body) > maxChars;
    if (onlyTooLong && attempt >= MAX_ATTEMPTS - 2) {
      try {
        body = cleanText(await shortenBodyIfNeeded(ai, body, maxChars));
        lastIssues = validateArticle({ title, body });
        parsed = { ...parsed, body };
        if (lastIssues.length === 0) break;
      } catch (error) {
        console.warn("正文压缩失败，继续重试:", error.message);
      }
    }
  }

  if (lastIssues.length > 0) {
    throw new Error(`Article validation failed after ${MAX_ATTEMPTS} attempts: ${lastIssues.join("；")}`);
  }

  const title = parsed.title.startsWith("快连") ? parsed.title : `快连 ${parsed.title}`;
  const description = parsed.description.slice(0, 120);
  const category = parsed.category || tags[0];
  const body = parsed.body;
  const slug = `${slugify(title)}-${Date.now()}-${index}`;

  return {
    slug,
    url: `/blog/${slug}/`,
    content: frontMatter({
      title,
      description,
      date,
      category,
      tags,
      heroImage: `/static/images/photo-1486406146926-c627a92ad1ab.jpg`,
      heroAlt: `${title} 配图`,
      body
    })
  };
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Set GEMINI_API_KEY or GOOGLE_API_KEY before generating articles.");

  const ai = new GoogleGenAI({ apiKey });
  const count = getCount();
  await fs.mkdir(blogDir, { recursive: true });

  const urls = [];
  for (let i = 0; i < count; i += 1) {
    const article = await createArticle(ai, i);
    await fs.writeFile(path.join(blogDir, `${article.slug}.md`), article.content, "utf8");
    urls.push(article.url);
  }

  await fs.writeFile(outputFile, JSON.stringify({ urls }, null, 2), "utf8");
  console.log(`Generated ${urls.length} article(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
