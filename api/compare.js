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
    const minNewPrice = Math.floor(ourPrice * 0.90);
    const maxNewPrice = Math.floor(ourPrice * 1.50); 
    
    let validCandidates = [];
    try {
        console.log(`\n===========================================`);
        console.log(`🔍 SEARCHING FOR: ${selected_model.product_title}`);
        console.log(`===========================================\n`);

        const searchTerm = encodeURIComponent("laptop windows");
        const bestSellerRes = await fetch(`https://api.keepa.com/search?key=${KEEPA_API_KEY}&domain=10&type=product&term=${searchTerm}`);
        const searchData = await bestSellerRes.json();
        
        if (searchData.error) {
            console.log("❌ KEEPA SEARCH API ERROR:", searchData.error);
            return res.status(500).json({ error: searchData.error.message });
        }

        const rawList = searchData.products || searchData.asins || [];
        const asins = rawList.map(p => typeof p === 'string' ? p : p.asin).filter(Boolean).slice(0, 20);
        
        console.log(`📦 Fetched ${asins.length} ASINs. Querying their prices...`);

        if (asins.length > 0) {
            const prodRes = await fetch(`https://api.keepa.com/product?key=${KEEPA_API_KEY}&domain=10&asin=${asins.join(',')}&stats=1&buybox=1`);
            const prodData = await prodRes.json();

            if (prodData.error) {
                console.log("❌ KEEPA PRODUCT API ERROR:", prodData.error);
                return res.status(500).json({ error: "Keepa Product API Error: " + prodData.error.message });
            }

            const items = prodData.products || [];
            console.log(`⚙️ Successfully loaded data for ${items.length} laptops. Applying strict filters...`);

            if (items.length === 0) {
                return res.status(429).json({ error: "Keepa Token Rate Limit reached. Please wait 60 seconds before comparing another model." });
            }

            for (const item of items) {
                const title = (item.title || "").toLowerCase();
                const featuresText = (item.features || []).join(" ").toLowerCase();
                const description = (item.description || "").toLowerCase();
                const titleAndFeatures = `${title} ${featuresText}`; 
                const fullText = `${title} ${featuresText} ${description}`; 
                
                const currentStats = item.stats?.current || [];
                const buyBoxStats = item.stats?.buyBoxPrice || -1;
                
                const amzPrice = currentStats[0] >= 0 ? currentStats[0] : -1;
                const newPrice = currentStats[1] >= 0 ? currentStats[1] : -1;
                const thirdPartyPrice = currentStats[18] >= 0 ? currentStats[18] : -1;

                let priceInt = -1;
                if (buyBoxStats > 0) priceInt = buyBoxStats;
                else if (thirdPartyPrice > 0) priceInt = thirdPartyPrice;
                else if (newPrice > 0) priceInt = newPrice;
                else if (amzPrice > 0) priceInt = amzPrice;
                
                const price = priceInt > 0 ? priceInt / 100 : 0; 

                const isCertifiedNew = !titleAndFeatures.includes("renew") && !titleAndFeatures.includes("refurb") && !titleAndFeatures.includes("refab") && !titleAndFeatures.includes("pre-owned") && !titleAndFeatures.includes("reconditioned") && !titleAndFeatures.includes("unboxed");
                const isNotAccessory = !title.includes("charger") && !title.includes("adapter") && !title.includes("bag") && !title.includes("skin") && !title.includes("sleeve") && !title.includes("battery");
                const matchesOS = fullText.includes("windows") || fullText.includes("win ") || fullText.includes("win11");
                const notChromebook = !fullText.includes("chromebook") && !fullText.includes("dos") && !fullText.includes("no os");
                const inPriceBracket = price >= minNewPrice && price <= maxNewPrice;

                let rejectionReason = "";
                if (price === 0) rejectionReason = "KEEPA HID THE PRICE";
                else if (!inPriceBracket) rejectionReason = `Price Out of Bounds (₹${price})`;
                else if (!isNotAccessory) rejectionReason = "Looks like an Accessory";
                else if (!matchesOS) rejectionReason = "OS Not Found (No 'Windows' in text)";
                else if (!notChromebook) rejectionReason = "Is a Chromebook/DOS";
                else if (!isCertifiedNew) rejectionReason = "Failed Refurb Check";
                
                if (rejectionReason === "") {
                    console.log(`✅ ACCEPTED: [₹${price}] ${title.substring(0, 45)}...`);
                    validCandidates.push({
                        product_title: item.title.replace(/[^\x00-\x7F]/g, "").trim(),
                        price: price,
                        url: `https://www.amazon.in/dp/${item.asin}`,
                        scraped_raw_specs: (item.features || []).join(" ") + " " + (item.description || "")
                    });
                    if (validCandidates.length >= 2) break; 
                } else {
                    console.log(`❌ REJECTED: [₹${price}] ${title.substring(0, 35)}... | ${rejectionReason}`);
                }
            }
        }
    } catch (e) { console.error("Server Error:", e); }

    const finalCompetitors = validCandidates;

    if (finalCompetitors.length === 0) {
        console.log(`\n🚨 CRITICAL FAIL: 0 Laptops passed the filters.`);
        return res.status(404).json({ error: "Strict filters applied: No brand new Amazon laptops found in this exact price range today." });
    }

    console.log(`\n🚀 SUCCESS: Sending ${finalCompetitors.length} laptops to OpenAI!`);

    const reasoningPrompt = `
You are a technical sales expert at NewJaisa.
Compare our Premium Refurbished laptop vs ${finalCompetitors.length} BRAND NEW Amazon competitors in the exact same price range.

NewJaisa Model: ${JSON.stringify(selected_model, null, 2)}
New Amazon Competitors: ${JSON.stringify(finalCompetitors, null, 2)}

STRICT RULES:
1. Generate exactly 11 parameters: "Processor", "RAM", "Storage (HDD/SSD)", "OS", "Screen Size", "Consistent Performance", "Display Quality", "Build Quality", "Thermals", "Handling & Portability", "Battery Life".
2. NO BLANKS OR "NOT SPECIFIED": Infer missing specs using internal knowledge.
3. EQUAL SPECS (TIES): If a feature offers the exact same value (e.g., both have 512GB SSD or both have Windows 11), you MUST use the EXACT SAME string for both "refurb_val" and every entry in "new_vals" (e.g., format both as "512 GB SSD") and set "winner" to "Tie". This ensures UI checkmarks do not falsely trigger.
4. CRITICAL: The "new_vals" array MUST contain exactly ${finalCompetitors.length} entries — one for each competitor, in the same order as the competitors array. ${finalCompetitors.length === 2 ? 'So new_vals must always be ["competitor1_value", "competitor2_value"].' : 'So new_vals must always be ["competitor1_value"].'}

Return valid JSON exactly matching this structure:
{
  "overall_winner": "string",
  "final_verdict": "string",
  "spec_ratings": { "refurbished": 9, "competitors": [${finalCompetitors.map(() => '7').join(', ')}] },
  "comparison_rows": [ { "parameter": "string", "refurb_val": "string", "new_vals": [${finalCompetitors.map(() => '"string"').join(', ')}], "winner": "Refurbished | Competitor | Tie", "reason": "string" } ]
}`;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: reasoningPrompt }], response_format: { type: "json_object" } })
    });

    const aiData = await aiRes.json();
    return res.status(200).json({ selected_model, competitors: finalCompetitors, review: JSON.parse(aiData.choices[0].message.content) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
}