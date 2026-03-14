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

    const normalizeText = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    const BLOCKED_NEW_KEYWORDS = [
      "renewed",
      "renew",
      "refurbished",
      "refurb",
      "refab",
      "reconditioned",
      "pre-owned",
      "pre owned",
      "open box",
      "open-box",
      "used",
      "second hand",
      "second-hand",
      "unboxed",
      "like new",
      "renewal"
    ];

    const BRAND_TOKENS = new Set([
      "lenovo",
      "hp",
      "dell",
      "asus",
      "acer",
      "msi",
      "samsung",
      "lg",
      "apple",
      "huawei",
      "microsoft"
    ]);

    const MODEL_STOPWORDS = new Set([
      "premium",
      "refurbished",
      "refurb",
      "renewed",
      "renew",
      "laptop",
      "notebook",
      "windows",
      "window",
      "business",
      "ultrabook",
      "touchscreen",
      "touch",
      "fhd",
      "uhd",
      "full",
      "hd",
      "ips",
      "intel",
      "amd",
      "core",
      "ryzen",
      "edition",
      "series",
      "thin",
      "light",
      "new",
      "pc",
      "computer",
      "gaming",
      "ssd",
      "hdd",
      "ram",
      "ddr3",
      "ddr4",
      "ddr5",
      "gb",
      "tb",
      "inch",
      "inchs",
      "display",
      "screen",
      "wifi",
      "bluetooth",
      "office",
      "home",
      "student",
      "students",
      "probook",
      "latitude",
      "elitebook",
      "thinkpad",
      "vivobook",
      "expertbook",
      "macbook",
      "book"
    ]);

    function getPriceFromKeepa(item) {
      const currentStats = item?.stats?.current || [];
      const buyBoxStats = item?.stats?.buyBoxPrice ?? -1;

      const amzPrice = currentStats[0] >= 0 ? currentStats[0] : -1;
      const newPrice = currentStats[1] >= 0 ? currentStats[1] : -1;
      const thirdPartyPrice = currentStats[18] >= 0 ? currentStats[18] : -1;

      let priceInt = -1;
      if (buyBoxStats > 0) priceInt = buyBoxStats;
      else if (thirdPartyPrice > 0) priceInt = thirdPartyPrice;
      else if (newPrice > 0) priceInt = newPrice;
      else if (amzPrice > 0) priceInt = amzPrice;

      return priceInt > 0 ? priceInt / 100 : 0;
    }

    function getLastPositiveValueFromHistory(history) {
      if (!Array.isArray(history) || history.length === 0) return null;
      for (let i = history.length - 1; i >= 0; i--) {
        const value = history[i];
        if (typeof value === "number" && value > 0) return value;
      }
      return null;
    }

    function getSalesRank(item) {
      const currentStats = item?.stats?.current || [];
      const currentRank = currentStats[3];
      if (typeof currentRank === "number" && currentRank > 0) return currentRank;

      const ref = item?.salesRankReference;
      const salesRanks = item?.salesRanks;
      if (ref && salesRanks && salesRanks[String(ref)]) {
        const fromMainRef = getLastPositiveValueFromHistory(salesRanks[String(ref)]);
        if (fromMainRef) return fromMainRef;
      }

      if (salesRanks && typeof salesRanks === "object") {
        let bestRank = null;
        for (const history of Object.values(salesRanks)) {
          const rank = getLastPositiveValueFromHistory(history);
          if (rank && (!bestRank || rank < bestRank)) bestRank = rank;
        }
        if (bestRank) return bestRank;
      }

      return null;
    }

    function tokenizeTitle(title) {
      return normalizeText(title)
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter(Boolean);
    }

    function extractFamilyTokens(title) {
      const tokens = tokenizeTitle(title).filter((token) => {
        if (MODEL_STOPWORDS.has(token)) return false;
        if (/^\d+(gb|tb|hz|w)$/.test(token)) return false;
        if (/^\d+(st|nd|rd|th)$/.test(token)) return false;
        if (/^win(10|11)?$/.test(token)) return false;
        if (/^\d{2,4}x\d{2,4}$/.test(token)) return false;
        return true;
      });

      const uniqueTokens = [...new Set(tokens)];
      const noBrandTokens = uniqueTokens.filter((token) => !BRAND_TOKENS.has(token));

      if (noBrandTokens.length >= 2) return noBrandTokens.slice(0, 4);
      if (uniqueTokens.length >= 2) return uniqueTokens.slice(0, 4);
      return uniqueTokens.slice(0, 4);
    }

    function isSameModelFamily(selectedTitle, candidateTitle) {
      const selectedTokens = extractFamilyTokens(selectedTitle);
      if (selectedTokens.length < 2) return false;

      const candidateTokens = new Set(tokenizeTitle(candidateTitle));
      return selectedTokens.every((token) => candidateTokens.has(token));
    }

    function extractConfigSignals(text) {
      const t = normalizeText(text);
      let cpuTier = 0;
      let cpuGen = 0;
      let ramGB = 0;
      let storageGB = 0;

      if (/\bi9\b/.test(t) || /\bryzen 9\b/.test(t)) cpuTier = 9;
      else if (/\bi7\b/.test(t) || /\bryzen 7\b/.test(t)) cpuTier = 7;
      else if (/\bi5\b/.test(t) || /\bryzen 5\b/.test(t)) cpuTier = 5;
      else if (/\bi3\b/.test(t) || /\bryzen 3\b/.test(t)) cpuTier = 3;
      else if (/\bpentium\b/.test(t) || /\bceleron\b/.test(t) || /\bathlon\b/.test(t)) cpuTier = 1;

      const genMatch = t.match(/(\d{1,2})(?:st|nd|rd|th)\s*gen/);
      if (genMatch) cpuGen = Number(genMatch[1] || 0);

      const ramMatches = [...t.matchAll(/(?:^|\s)(\d{1,3})\s*gb\s*(?:ram|memory|ddr\d)/g)];
      if (ramMatches.length) {
        ramGB = Math.max(...ramMatches.map((m) => Number(m[1] || 0)));
      } else {
        const reverseRamMatch = t.match(/(?:ram|memory)\s*(\d{1,3})\s*gb/);
        if (reverseRamMatch) ramGB = Number(reverseRamMatch[1] || 0);
      }

      const storageMatches = [
        ...t.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)\s*(tb|gb)\s*(?:ssd|hdd|nvme|pcie|emmc|storage)/g),
        ...t.matchAll(/(?:ssd|hdd|nvme|pcie|emmc|storage)\s*(\d+(?:\.\d+)?)\s*(tb|gb)/g)
      ];

      if (storageMatches.length) {
        storageGB = Math.max(
          ...storageMatches.map((m) => {
            const qty = Number(m[1] || 0);
            const unit = String(m[2] || "").toLowerCase();
            return unit === "tb" ? qty * 1024 : qty;
          })
        );
      }

      return { cpuTier, cpuGen, ramGB, storageGB };
    }

    function getConfigScore(candidate) {
      const text = `${candidate.product_title || ""} ${candidate.scraped_raw_specs || ""}`;
      const { cpuTier, cpuGen, ramGB, storageGB } = extractConfigSignals(text);
      return (cpuTier * 1000000) + (cpuGen * 10000) + (ramGB * 100) + storageGB;
    }

    function pickLowerConfigCandidate(existingCandidate, incomingCandidate) {
      const existingScore = getConfigScore(existingCandidate);
      const incomingScore = getConfigScore(incomingCandidate);

      if (incomingScore !== existingScore) {
        return incomingScore < existingScore ? incomingCandidate : existingCandidate;
      }

      if (Number(incomingCandidate.price || 0) !== Number(existingCandidate.price || 0)) {
        return Number(incomingCandidate.price || 0) < Number(existingCandidate.price || 0)
          ? incomingCandidate
          : existingCandidate;
      }

      return Number(incomingCandidate.sales_rank || Number.MAX_SAFE_INTEGER) < Number(existingCandidate.sales_rank || Number.MAX_SAFE_INTEGER)
        ? incomingCandidate
        : existingCandidate;
    }

    function getTopPercent(positionIndex, totalCount) {
      if (!totalCount || totalCount <= 0) return null;
      return Math.max(1, Math.ceil(((positionIndex + 1) / totalCount) * 100));
    }

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
      const asins = rawList
        .map((p) => (typeof p === "string" ? p : p.asin))
        .filter(Boolean)
        .slice(0, 40);

      console.log(`📦 Fetched ${asins.length} ASINs. Querying their prices and market position...`);

      if (asins.length > 0) {
        const prodRes = await fetch(`https://api.keepa.com/product?key=${KEEPA_API_KEY}&domain=10&asin=${asins.join(",")}&stats=1&buybox=1`);
        const prodData = await prodRes.json();

        if (prodData.error) {
          console.log("❌ KEEPA PRODUCT API ERROR:", prodData.error);
          return res.status(500).json({ error: "Keepa Product API Error: " + prodData.error.message });
        }

        const items = prodData.products || [];
        console.log(`⚙️ Successfully loaded data for ${items.length} laptops. Applying strict filters + same-model cleanup...`);

        if (items.length === 0) {
          return res.status(429).json({ error: "Keepa Token Rate Limit reached. Please wait 60 seconds before comparing another model." });
        }

        for (const item of items) {
          const rawTitle = String(item.title || "");
          const title = normalizeText(rawTitle);
          const featuresText = normalizeText((item.features || []).join(" "));
          const description = normalizeText(item.description);
          const titleAndFeatures = `${title} ${featuresText}`.trim();
          const fullText = `${title} ${featuresText} ${description}`.trim();

          const price = getPriceFromKeepa(item);
          const salesRank = getSalesRank(item);
          const monthlySold = Number(item?.monthlySold || 0) || 0;

          const isCertifiedNew = !BLOCKED_NEW_KEYWORDS.some((kw) => titleAndFeatures.includes(kw));
          const isNotAccessory = !title.includes("charger") && !title.includes("adapter") && !title.includes("bag") && !title.includes("skin") && !title.includes("sleeve") && !title.includes("battery");
          const matchesOS = fullText.includes("windows") || fullText.includes("win ") || fullText.includes("win11") || fullText.includes("win10");
          const notChromebook = !fullText.includes("chromebook") && !fullText.includes("dos") && !fullText.includes("no os");
          const inPriceBracket = price >= minNewPrice && price <= maxNewPrice;
          const hasSalesRank = typeof salesRank === "number" && salesRank > 0;
          const sameAsRefurbModel = isSameModelFamily(selected_model.product_title, rawTitle);

          let rejectionReason = "";
          if (price === 0) rejectionReason = "KEEPA HID THE PRICE";
          else if (!inPriceBracket) rejectionReason = `Price Out of Bounds (₹${price})`;
          else if (!isNotAccessory) rejectionReason = "Looks like an Accessory";
          else if (!matchesOS) rejectionReason = "OS Not Found (No 'Windows' in text)";
          else if (!notChromebook) rejectionReason = "Is a Chromebook/DOS";
          else if (!isCertifiedNew) rejectionReason = "Failed Refurb Check";
          else if (!hasSalesRank) rejectionReason = "No Sales Rank Found";
          else if (sameAsRefurbModel) rejectionReason = "Same Model Family As Refurb";

          if (rejectionReason === "") {
            console.log(`✅ ACCEPTED: [₹${price}] [Rank #${salesRank}] ${title.substring(0, 45)}...`);
            validCandidates.push({
              asin: item.asin,
              product_title: rawTitle.replace(/[^\x00-\x7F]/g, "").trim(),
              price,
              sales_rank: salesRank,
              monthly_sold: monthlySold,
              url: `https://www.amazon.in/dp/${item.asin}`,
              scraped_raw_specs: `${(item.features || []).join(" ")} ${item.description || ""}`.trim()
            });
          } else {
            console.log(`❌ REJECTED: [₹${price}] [Rank ${salesRank || "NA"}] ${title.substring(0, 35)}... | ${rejectionReason}`);
          }
        }
      }
    } catch (e) {
      console.error("Server Error:", e);
    }

    const dedupedByFamily = new Map();
    for (const candidate of validCandidates) {
      const familyKeyTokens = extractFamilyTokens(candidate.product_title);
      const familyKey = familyKeyTokens.length ? familyKeyTokens.join("|") : normalizeText(candidate.product_title);

      if (!dedupedByFamily.has(familyKey)) {
        dedupedByFamily.set(familyKey, candidate);
      } else {
        const chosen = pickLowerConfigCandidate(dedupedByFamily.get(familyKey), candidate);
        dedupedByFamily.set(familyKey, chosen);
      }
    }

    validCandidates = Array.from(dedupedByFamily.values());

    validCandidates.sort((a, b) => {
      const rankA = typeof a.sales_rank === "number" ? a.sales_rank : Number.MAX_SAFE_INTEGER;
      const rankB = typeof b.sales_rank === "number" ? b.sales_rank : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return a.price - b.price;
    });

    const totalRankedCandidates = validCandidates.length;
    validCandidates = validCandidates.map((candidate, index) => ({
      ...candidate,
      top_percent_in_price: getTopPercent(index, totalRankedCandidates)
    }));

    const finalCompetitors = validCandidates.slice(0, 2);

    if (finalCompetitors.length === 0) {
      console.log(`\n🚨 CRITICAL FAIL: 0 Laptops passed the filters.`);
      return res.status(404).json({ error: "Strict filters applied: No brand new ranked Amazon laptops found in this exact price range today." });
    }

    console.log(`\n🚀 SUCCESS: Sending ${finalCompetitors.length} cleaned competitors to OpenAI!`);

    const reasoningPrompt = `
You are a technical sales expert at NewJaisa.
Compare our Premium Refurbished laptop vs ${finalCompetitors.length} BRAND NEW Amazon competitors in the exact same price range.

NewJaisa Model: ${JSON.stringify(selected_model, null, 2)}
New Amazon Competitors (already sorted by strongest market position first): ${JSON.stringify(finalCompetitors, null, 2)}

STRICT RULES:
1. Generate exactly 11 parameters: "Processor", "RAM", "Storage (HDD/SSD)", "OS", "Screen Size", "Consistent Performance", "Display Quality", "Build Quality", "Thermals", "Handling & Portability", "Battery Life".
2. NO BLANKS OR "NOT SPECIFIED": Infer missing specs using internal knowledge.
3. EQUAL SPECS (TIES): If a feature offers the exact same value (e.g., both have 512GB SSD or both have Windows 11), you MUST use the EXACT SAME string for both "refurb_val" and every entry in "new_vals" (e.g., format both as "512 GB SSD") and set "winner" to "Tie". This ensures UI checkmarks do not falsely trigger.
4. CRITICAL: The "new_vals" array MUST contain exactly ${finalCompetitors.length} entries — one for each competitor, in the same order as the competitors array. ${finalCompetitors.length === 2 ? 'So new_vals must always be ["competitor1_value", "competitor2_value"].' : 'So new_vals must always be ["competitor1_value"].'}
5. Because the competitors are already sorted, keep their order unchanged.

Return valid JSON exactly matching this structure:
{
  "overall_winner": "string",
  "final_verdict": "string",
  "spec_ratings": { "refurbished": 9, "competitors": [${finalCompetitors.map(() => '7').join(', ')}] },
  "comparison_rows": [ { "parameter": "string", "refurb_val": "string", "new_vals": [${finalCompetitors.map(() => '"string"').join(', ')}], "winner": "Refurbished | Competitor | Tie", "reason": "string" } ]
}`;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: reasoningPrompt }],
        response_format: { type: "json_object" }
      })
    });

    const aiData = await aiRes.json();

    if (!aiRes.ok) {
      return res.status(aiRes.status).json({ error: aiData?.error?.message || "OpenAI request failed" });
    }

    return res.status(200).json({
      selected_model,
      competitors: finalCompetitors,
      review: JSON.parse(aiData.choices[0].message.content)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}