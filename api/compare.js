export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "compare API reachable"
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Method not allowed"
      });
    }

    const body = req.body || {};
    const selected_model = body.selected_model || null;

    if (!selected_model || !selected_model.product_title || !selected_model.specs) {
      return res.status(400).json({
        error: "Missing selected_model or specs"
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY missing in Vercel environment variables"
      });
    }

    const category = String(selected_model.category || "").toLowerCase();
    const ourPrice = Number(selected_model.our_price || 0);

    const competitorPrompt = `
You are a laptop market analyst.

Find 6 NEW laptops sold in India that compete with this refurbished laptop.

Selected refurbished laptop:
${JSON.stringify(selected_model, null, 2)}

Rules:
- If category is gaming, return gaming laptops only
- If category is business, portable, creator, or mainstream, return non-gaming laptops that fit that category
- Keep the price roughly between 90% and 135% of the refurb price
- Return realistic laptop model families commonly sold in India
- Return only NEW laptops
- Do not return the refurbished laptop itself
- Keep specs realistic and concise

Return valid JSON only in this exact structure:
{
  "candidates": [
    {
      "id": "string",
      "product_title": "string",
      "condition": "New",
      "category": "string",
      "price": 0,
      "specs": {
        "processor": "string",
        "ram": "string",
        "storage": "string",
        "display": "string",
        "gpu": "string"
      }
    }
  ]
}
`;

    const competitorResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: competitorPrompt,
        text: {
          format: { type: "json_object" }
        }
      })
    });

    const competitorData = await competitorResponse.json();

    if (!competitorResponse.ok || competitorData?.error) {
      return res.status(500).json({
        error: "Failed to generate competitor laptops",
        raw: competitorData
      });
    }

    const competitorRaw = competitorData?.output?.[0]?.content?.[0]?.text;
    if (!competitorRaw) {
      return res.status(500).json({
        error: "No competitor data returned"
      });
    }

    let competitorParsed;
    try {
      competitorParsed = JSON.parse(competitorRaw);
    } catch (err) {
      return res.status(500).json({
        error: "Competitor JSON parse failed",
        rawText: competitorRaw
      });
    }

    let candidates = Array.isArray(competitorParsed.candidates)
      ? competitorParsed.candidates
      : [];

    // Safety filters
    candidates = candidates.filter(item => {
      if (!item || !item.product_title || !item.specs || !item.price) return false;
      const itemCategory = String(item.category || "").toLowerCase();

      if (category === "gaming") {
        return itemCategory === "gaming";
      }

      return itemCategory !== "gaming";
    });

    if (ourPrice > 0) {
      candidates = candidates.filter(item => {
        const p = Number(item.price || 0);
        return p >= Math.round(ourPrice * 0.9) && p <= Math.round(ourPrice * 1.35);
      });
    }

    const comparisonCandidates = candidates.slice(0, 3);
    const alternativesPool = candidates.slice(3);

    const reasoningPrompt = `
You are generating customer-facing content for a NewJaisa refurbished laptop comparison widget.

The widget compares:
- 1 refurbished laptop from NewJaisa
- 3 similarly priced NEW laptops in the same category

Selected refurbished laptop:
${JSON.stringify(selected_model, null, 2)}

Comparison candidates:
${JSON.stringify(comparisonCandidates, null, 2)}

Alternative pool:
${JSON.stringify(alternativesPool, null, 2)}

NewJaisa trust points:
- 72-point quality check
- 1-year warranty
- 14-day return and replacement
- lifetime buyback guarantee
- Quick Heal security / data protection positioning

Return valid JSON only in exactly this structure:
{
  "banner_main": "string",
  "banner_sub": "string",
  "price_comparison": {
    "comparison_note": "string"
  },
  "why_buy_from_newjaisa": ["string", "string", "string", "string"],
  "best_for_users": ["string", "string", "string", "string"],
  "advantages": ["string", "string", "string", "string"],
  "refurb_value_score": 9,
  "refurb_verdict": "string",
  "new_value_scores": [6, 6, 5],
  "new_verdicts": ["string", "string", "string"],
  "alternatives": [
    {
      "id": "string",
      "reason": "string"
    }
  ],
  "cta_title": "string",
  "cta_text": "string",
  "cta_button": "string"
}

Rules:
- keep all lines compact
- emphasize that refurb can give better specs at the same budget
- do not invent policies beyond input
- keep value scores realistic
- alternatives must use IDs from the alternative pool when available
`;

    const reasoningResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: reasoningPrompt,
        text: {
          format: { type: "json_object" }
        }
      })
    });

    const reasoningData = await reasoningResponse.json();

    if (!reasoningResponse.ok || reasoningData?.error) {
      return res.status(500).json({
        error: "Failed to generate comparison reasoning",
        raw: reasoningData
      });
    }

    const reasoningRaw = reasoningData?.output?.[0]?.content?.[0]?.text;
    if (!reasoningRaw) {
      return res.status(500).json({
        error: "No reasoning data returned"
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(reasoningRaw);
    } catch (err) {
      return res.status(500).json({
        error: "Reasoning JSON parse failed",
        rawText: reasoningRaw
      });
    }

    let alternatives = (parsed.alternatives || []).map(alt => {
      const match = candidates.find(item => item.id === alt.id);
      if (!match) return null;
      return {
        id: match.id,
        product_title: match.product_title,
        price: match.price,
        price_text: match.price ? `₹${Number(match.price).toLocaleString("en-IN")}` : "",
        condition: match.condition || "New",
        category: match.category || "",
        specs: match.specs || {},
        reason: alt.reason || ""
      };
    }).filter(Boolean);

    if (!alternatives.length) {
      alternatives = candidates.slice(3, 6).map(item => ({
        id: item.id,
        product_title: item.product_title,
        price: item.price,
        price_text: item.price ? `₹${Number(item.price).toLocaleString("en-IN")}` : "",
        condition: item.condition || "New",
        category: item.category || "",
        specs: item.specs || {},
        reason: "A nearby new-laptop option in a similar budget range."
      }));
    }

    return res.status(200).json({
      selected_model,
      comparison_candidates: comparisonCandidates,
      ai: parsed,
      alternatives
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Internal server error",
      stack: error.stack
    });
  }
}