export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body || {};
    const selected_model = body.selected_model || null;
    const { OPENAI_API_KEY, KEEPA_API_KEY } = process.env;

    if (!selected_model || !OPENAI_API_KEY || !KEEPA_API_KEY) {
      return res.status(400).json({ error: "Missing required data or API keys" });
    }

    const ourPrice = Number(selected_model.our_price || 0);
    // WIDENED PRICE BRACKET: 90% to 135% (Catches the realistic ₹28k-₹31k new laptops)
    const minNewPrice = Math.floor(ourPrice * 0.90);
    const maxNewPrice = Math.floor(ourPrice * 1.35);
    
    let validCandidates = [];
    try {
        // Broadened search: Just look for Windows laptops to allow 15.6" budget models in
        const bestSellerRes = await fetch(`https://api.keepa.com/search?key=${KEEPA_API_KEY}&domain=10&type=product&term=laptop windows`);
        const searchData = await bestSellerRes.json();
        
        // Grab top 50 to ensure we have a good pool
        const asins = (searchData.products || []).map(p => p.asin).slice(0, 50);

        if (asins.length > 0) {
            const prodRes = await fetch(`https://api.keepa.com/product?key=${KEEPA_API_KEY}&domain=10&asin=${asins.join(',')}&stats=1`);
            const prodData = await prodRes.json();

            for (const item of (prodData.products || [])) {
                const title = (item.title || "").toLowerCase();
                const featuresText = (item.features || []).join(" ").toLowerCase();
                const description = (item.description || "").toLowerCase();
                const fullText = `${title} ${featuresText} ${description}`;
                const price = (item.stats?.current?.[1] || 0) / 100; 

                // Deep Scan Shield (Still incredibly strict against fakes)
                const isCertifiedNew = !fullText.includes("renew") && !fullText.includes("refurb") && !fullText.includes("refab") && !fullText.includes("condition") && !fullText.includes("grade") && !fullText.includes("pre-owned") && !fullText.includes("certified") && !fullText.includes("reconditioned") && !fullText.includes("unboxed") && !fullText.includes("used ");
                
                // Relaxed OS Match: Catch "Windows", "Win 11", "Win11"
                const matchesOS = fullText.includes("windows") || fullText.includes("win ") || fullText.includes("win11");
                
                const isNotAccessory = !fullText.includes("charger") && !fullText.includes("adapter") && !fullText.includes("bag") && !fullText.includes("skin") && !fullText.includes("dos") && !fullText.includes("no os") && !fullText.includes("chromebook");
                
                const inPriceBracket = price >= minNewPrice && price <= maxNewPrice;
                const isKeepaVerifiedNew = item.condition === 1 || !item.condition;

                // NOTICE: matchesSize is removed so 15.6" budget laptops are allowed to compete!
                if (isCertifiedNew && isKeepaVerifiedNew && matchesOS && isNotAccessory && inPriceBracket) {
                    validCandidates.push({
                        product_title: item.title.replace(/[^\x00-\x7F]/g, "").trim(),
                        price: price,
                        url: `https://www.amazon.in/dp/${item.asin}`,
                        scraped_raw_specs: (item.features || []).join(" ")
                    });
                    if (validCandidates.length >= 3) break; 
                }
            }
        }
    } catch (e) { console.error("Keepa Error:", e); }

    validCandidates.sort((a, b) => Math.abs(a.price - ourPrice) - Math.abs(b.price - ourPrice));
    
    const finalCompetitors = validCandidates;
    const numCompetitors = finalCompetitors.length;

    if (numCompetitors === 0) {
        return res.status(404).json({ error: "Strict filters applied: No brand new Amazon laptops found in this exact price range today. Try expanding the price bracket slightly." });
    }

    const reasoningPrompt = `
You are a technical sales expert at NewJaisa.
Compare our Premium Refurbished laptop vs ${numCompetitors} BRAND NEW Amazon competitors in the exact same price range.

NewJaisa Model: ${JSON.stringify(selected_model, null, 2)}
New Amazon Competitors: ${JSON.stringify(finalCompetitors, null, 2)}

STRICT RULES FOR COMPARISON ROWS:
1. You MUST generate exactly these 11 parameters in the 'comparison_rows' array:
   "Processor", "RAM", "Storage (HDD/SSD)", "OS", "Screen Size", "Consistent Performance", "Display Quality", "Build Quality", "Thermals", "Handling & Portability", "Battery Life".
2. FACTUAL WINS: Refurbished enterprise laptops have vastly superior Build Quality (metal/carbon vs cheap plastic), Thermals, and Consistent Performance.
3. Be honest: Brand new laptops might win on "Battery Life". 
4. The 'new_vals' array MUST contain exactly ${numCompetitors} items. 
5. Extract specs from titles if missing. Do not use "N/A".

Return valid JSON exactly matching this structure:
{
  "overall_winner": "string",
  "final_verdict": "string",
  "spec_ratings": { "refurbished": 9, "competitors": [/* Array of ${numCompetitors} integers */] },
  "comparison_rows": [ 
    { "parameter": "string", "refurb_val": "string", "new_vals": [/* Array of ${numCompetitors} strings */], "winner": "Refurbished or Competitor Name", "reason": "string" } 
  ]
}`;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-3.5-turbo", messages: [{ role: "user", content: reasoningPrompt }], response_format: { type: "json_object" } })
    });

    const aiData = await aiRes.json();
    return res.status(200).json({ selected_model, competitors: finalCompetitors, review: JSON.parse(aiData.choices[0].message.content) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
}