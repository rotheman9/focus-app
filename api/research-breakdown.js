// Vercel Serverless Function: Research-powered task breakdown
// Env vars expected:
// - ANTHROPIC_API_KEY (required)
// - SERPAPI_API_KEY (optional)

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Very naive HTML -> text stripper to keep payload small
 */
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function webSearch(task) {
  // Try SerpAPI first if available
  const apiKey = process.env.SERPAPI_API_KEY;
  if (apiKey) {
    try {
      // More specific search queries for better results
      const searchQueries = [
        `${task} step by step guide 2024`,
        `${task} best practices tutorial`,
        `${task} implementation checklist`,
        `${task} project requirements breakdown`,
        `${task} development roadmap`
      ];
      
      let allResults = [];
      
      for (const query of searchQueries) {
        const q = encodeURIComponent(query);
        const url = `https://serpapi.com/search.json?engine=google&q=${q}&num=3&api_key=${apiKey}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const results = (data.organic_results || []).map(r => ({
            title: r.title,
            link: r.link,
            snippet: r.snippet || ""
          }));
          allResults = allResults.concat(results);
        }
      }
      
      // Remove duplicates and return top results
      const uniqueResults = allResults.filter((result, index, self) => 
        index === self.findIndex(r => r.link === result.link)
      );
      
      if (uniqueResults.length) return uniqueResults.slice(0, 8);
    } catch (_) {}
  }

  // Fallback: Wikipedia search for conceptual grounding
  try {
    const q = encodeURIComponent(task);
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&srlimit=3&format=json&origin=*`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const pages = (data.query?.search || []).map(p => ({
      title: p.title,
      link: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
      snippet: stripHtml(p.snippet)
    }));
    return pages.slice(0, 3);
  } catch (_) {
    return [];
  }
}

async function fetchPages(results) {
  const pages = [];
  for (const r of results) {
    try {
      const resp = await fetch(r.link, { redirect: "follow" });
      if (!resp.ok) continue;
      const html = await resp.text();
      const text = stripHtml(html).slice(0, 10000);
      pages.push({ title: r.title, url: r.link, text });
    } catch (_) {
      // ignore fetch failures
    }
  }
  return pages;
}

function buildPrompt(task, pages) {
  let context = "";
  if (pages.length > 0) {
    context = pages
      .slice(0, 3)
      .map((p, i) => `Source ${i + 1}: ${p.title} (${p.url})\n${p.text.slice(0, 2500)}`)
      .join("\n\n");
  }

  const prompt = `You are an expert project planner and researcher. Create a precise, actionable micro-task plan that reflects real-world best practices and current industry standards.

Primary task: "${task}"

Use the following web context (if any) to inform the plan:
${context || "(no web context provided)"}

Return ONLY valid JSON matching this TypeScript type:
{
  "microTasks": Array<{
    "text": string,
    "estimatedTimeMinutes": number,
    "priority": "high" | "medium" | "low",
    "dependsOn"?: number[]
  }>
}

CRITICAL REQUIREMENTS:
• Generate SPECIFIC, ACTIONABLE steps, not generic concepts
• Each task should be something you can actually DO right now
• Include concrete deliverables and measurable outcomes
• Use current best practices and modern tools/technologies
• Research the specific domain if needed to provide accurate steps

For technical projects, include:
• Specific tool setup and configuration steps
• Exact commands or code snippets where relevant
• Modern frameworks, libraries, and best practices
• Testing, deployment, and monitoring specifics
• Security and performance considerations

For business/creative projects, include:
• Research and validation steps
• Specific planning and documentation tasks
• Execution and iteration phases
• Quality assurance and feedback loops
• Launch and measurement strategies

Guidelines:
• 8-15 micro-tasks that are specific and outcome-driven
• Estimate realistic durations (15–120 minutes each)
• Include dependencies by index (0-based) if a task requires another first
• Assume a competent person with basic tools
• Focus on what makes THIS specific project unique
• No commentary, no markdown — just JSON.`;
  return prompt;
}

async function callAnthropic(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY env var");
  }
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 2000,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic error: ${res.status} ${text}`);
  }
  const data = await res.json();
  const content = (data.content && data.content[0] && data.content[0].text) || "";
  return content;
}

async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY env var");
  }
  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an expert planner. Respond ONLY with strict JSON per user instructions."
        },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${text}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  return content;
}

function safeParseJson(text) {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch (_) {}
  // Try to extract code block
  const match = text.match(/```json[\s\S]*?```/i) || text.match(/\{[\s\S]*\}/);
  if (match) {
    const block = match[0].replace(/```json|```/g, "");
    try {
      return JSON.parse(block);
    } catch (_) {}
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const { task } = req.body || {};
    if (!task || typeof task !== "string") {
      res.status(400).json({ error: "Missing 'task' in request body" });
      return;
    }

    // Optional web research
    const results = await webSearch(task);
    const pages = results.length ? await fetchPages(results) : [];

    const prompt = buildPrompt(task, pages);
    let raw;
    // Prefer OpenAI if available, else Anthropic
    if (process.env.OPENAI_API_KEY) {
      raw = await callOpenAI(prompt);
    } else {
      raw = await callAnthropic(prompt);
    }
    const parsed = safeParseJson(raw);

    const microTasks = Array.isArray(parsed?.microTasks) ? parsed.microTasks : [];
    const normalized = microTasks.slice(0, 20).map((t, idx) => ({
      id: idx + 1,
      text: String(t.text || "Untitled task").trim(),
      estimatedTime: Math.max(10, Math.min(180, Number(t.estimatedTimeMinutes) || 30)),
      priority: ["high", "medium", "low"].includes(t.priority) ? t.priority : "medium",
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : []
    }));

    const sources = results.map(r => ({ title: r.title, url: r.link }));

    res.status(200).json({
      breakdown: normalized,
      sources,
      meta: { usedWebResearch: pages.length > 0 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Internal error" });
  }
};


