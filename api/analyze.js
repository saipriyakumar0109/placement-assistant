// api/analyze.js
// Vercel Serverless Function: compares placement drive announcement against student profile

module.exports = async function handler(req, res) {
  // 1. Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed. Please send a POST request with JSON.' });
  }

  // 2. Read the Gemini API key from environment variables (NEVER hardcoded)
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured in server environment variables. Please add it to your Vercel project settings or .env.local file.'
    });
  }

  try {
    // 3. Parse incoming request body
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { profile, message } = body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Please provide the placement message to analyze.' });
    }

    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({ error: 'Please provide your profile details.' });
    }

    // 4. Construct prompt for Gemini
    const prompt = `You are an expert campus placement assistant. Your task is to evaluate whether a student is eligible for a placement opportunity by comparing their profile against the criteria described in a placement announcement message.

Student Profile:
- Full Name: ${profile.fullName || 'Not provided'}
- Branch / Department: ${profile.branch || 'Not provided'}
- CGPA: ${profile.cgpa || 'Not provided'}
- Current Backlogs: ${profile.currentBacklogs !== undefined ? profile.currentBacklogs : 'Not provided'}
- History of Backlogs: ${profile.historyBacklogs || 'Not provided'}
- 10th Percentage: ${profile.tenthPercent ? profile.tenthPercent + '%' : 'Not provided'}
- 12th Percentage: ${profile.twelfthPercent ? profile.twelfthPercent + '%' : 'Not provided'}
- Graduation Year: ${profile.graduationYear || 'Not provided'}
- Skills: ${profile.skills || 'Not provided'}

Placement Message:
"""
${message.trim()}
"""

Evaluation Rules:
1. Examine all eligibility rules stated in the placement message (such as branch/degree, minimum CGPA, backlog rules, 10th/12th percentages, graduation year, required skills).
2. Status determination:
   - "Eligible": The student clearly meets ALL stated eligibility criteria.
   - "Not eligible": The student clearly fails one or more stated eligibility criteria.
   - "Not sure": The placement message does NOT clearly state a rule for a necessary criteria, or the student profile lacks information needed to verify eligibility. NEVER guess or assume.
3. In "reason", write a concise explanation quoting the company's rule and contrasting it with the student's matching value (e.g., "Company requires CGPA >= 7.5; your CGPA is 8.2"). If "Not sure", explain exactly which rule or profile detail is missing or ambiguous.
4. In "todo", provide a list of concrete, actionable next steps for the student (e.g. "Register on company portal before deadline", "Revise SQL and Data Structures", "Prepare resume highlighting Python").
5. In "deadlines", extract all dates and times mentioned in the message (e.g. registration deadline, assessment date, interview rounds). Format each with a title and date string. If no dates are mentioned, return an empty list [].

Output Format:
You MUST respond with ONLY a valid JSON object matching this exact structure:
{
  "status": "Eligible" | "Not eligible" | "Not sure",
  "reason": "explanation quoting company rule and student value",
  "todo": ["step 1", "step 2"],
  "deadlines": [
    { "title": "event name", "date": "date and time" }
  ]
}`;

    // Helper function to call a Gemini model
    async function callGemini(modelName) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json'
          }
        })
      });
      const data = await response.json();
      return { response, data };
    }

    // Helper to detect 503 or high demand / resource exhausted errors
    function isHighDemand(status, msg) {
      if (status === 503 || status === 429) return true;
      const text = (msg || '').toLowerCase();
      return (
        text.includes('503') ||
        text.includes('high demand') ||
        text.includes('overloaded') ||
        text.includes('unavailable') ||
        text.includes('resource exhausted') ||
        text.includes('rate limit')
      );
    }

    // Helper to sleep for a given number of milliseconds
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const primaryModel = 'gemini-flash-latest';
    const fallbackModel = 'gemini-flash-lite-latest';
    let resultData = null;
    let lastErrorMsg = '';

    // Step 4: Attempt with gemini-flash-latest, retrying up to 2 times with a 1-second wait on 503/high demand
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { response, data } = await callGemini(primaryModel);
        if (response.ok) {
          resultData = data;
          break;
        } else {
          const errorMsg = data?.error?.message || `HTTP ${response.status}`;
          lastErrorMsg = errorMsg;
          if (isHighDemand(response.status, errorMsg)) {
            if (attempt < 2) {
              await sleep(1000); // 1-second wait
              continue;
            }
          } else {
            // Non-transient error (e.g., bad request, invalid API key)
            throw new Error(errorMsg);
          }
        }
      } catch (err) {
        lastErrorMsg = err.message;
        if (attempt < 2 && isHighDemand(0, err.message)) {
          await sleep(1000);
          continue;
        }
        if (!isHighDemand(0, err.message)) {
          throw err;
        }
      }
    }

    // If primary model still failed due to high demand after retries, try gemini-flash-lite-latest
    if (!resultData) {
      try {
        const { response, data } = await callGemini(fallbackModel);
        if (response.ok) {
          resultData = data;
        } else {
          const fallbackError = data?.error?.message || `HTTP ${response.status}`;
          console.error('Fallback model error:', fallbackError);
          return res.status(503).json({
            error: 'Gemini service is currently experiencing very high demand. Please wait a few moments and try again.'
          });
        }
      } catch (fallbackErr) {
        console.error('Fallback model failure:', fallbackErr);
        return res.status(503).json({
          error: 'Gemini service is currently busy. Please try again shortly.'
        });
      }
    }

    // Extract text reply
    const rawReply = resultData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawReply) {
      return res.status(500).json({ error: 'Gemini returned an empty analysis. Please try again.' });
    }

    // Safely parse JSON (strip markdown code fences if present)
    let parsed;
    try {
      let cleaned = rawReply.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '');
      }
      parsed = JSON.parse(cleaned.trim());
    } catch (parseErr) {
      console.error('JSON parse error from Gemini output:', rawReply);
      return res.status(500).json({ error: 'Could not parse analysis output from Gemini. Please try again.' });
    }

    // Normalize result structure
    const validStatus = ['Eligible', 'Not eligible', 'Not sure'].includes(parsed.status)
      ? parsed.status
      : 'Not sure';

    return res.status(200).json({
      status: validStatus,
      reason: parsed.reason || 'No detailed reason provided.',
      todo: Array.isArray(parsed.todo) ? parsed.todo : [],
      deadlines: Array.isArray(parsed.deadlines) ? parsed.deadlines : []
    });

  } catch (error) {
    console.error('Error in /api/analyze:', error);
    return res.status(500).json({ error: error.message || 'An unexpected error occurred during analysis.' });
  }
};
