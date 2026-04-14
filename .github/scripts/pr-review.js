const BOT_REVIEW_MARKER = '🤖 PR Reviewer'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const AWS_BEARER_TOKEN_BEDROCK = process.env.AWS_BEARER_TOKEN_BEDROCK
const AWS_REGION = process.env.AWS_REGION || 'us-east-1'
const PR_NUMBER = parseInt(process.env.PR_NUMBER, 10)
const HEAD_SHA = process.env.HEAD_SHA
const [REPO_OWNER, REPO_NAME] = (process.env.GITHUB_REPOSITORY || '').split('/')

async function main () {
  try {
    const missing = ['GITHUB_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'PR_NUMBER', 'GITHUB_REPOSITORY', 'HEAD_SHA']
      .filter(k => !process.env[k])
    if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`)
    if (isNaN(PR_NUMBER)) throw new Error(`Invalid PR_NUMBER: "${process.env.PR_NUMBER}"`)

    console.log(`Reviewing PR #${PR_NUMBER} on ${REPO_OWNER}/${REPO_NAME}`)

    const diff = await getPRDiff()
    if (!diff || diff.length < 10) { console.log('No diff to review'); return }
    if (diff.length > 100000) console.warn(`Diff truncated: ${diff.length} → 100000 chars`)

    const botReviews = await getBotReviews()
    const previousSuggestions = await getPreviousSuggestions(botReviews)
    console.log(`Found ${previousSuggestions.length} previous suggestions`)

    const review = await callClaude(diff, previousSuggestions)

    await cleanupPreviousReviews(botReviews)
    await postReview(review)

    console.log('Review posted successfully')
  } catch (err) {
    console.error('Error:', err.message)
    process.exit(1)
  }
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

// Retries on transient errors with exponential backoff; respects Retry-After header when present
// retry403: true for GitHub calls (403 = secondary rate limit); false for Bedrock (403 = bad credentials, permanent)
async function fetchWithRetry (url, options, retries = 3, retry403 = false) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, options)
    const isTransient = res.status === 429 || (retry403 && res.status === 403) || res.status >= 500
    if (!isTransient || attempt === retries) return res
    const retryAfter = res.headers.get('retry-after')
    const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt)
    console.warn(`Request failed (${res.status}), retrying in ${wait}ms`)
    await new Promise(r => setTimeout(r, wait))
  }
}

// Generic authenticated GET against the GitHub API, returns parsed JSON
async function githubGet (url) {
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  }, 3, true)
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${url}`)
  return res.json()
}

// Fetches the raw unified diff for the PR
async function getPRDiff () {
  const res = await fetchWithRetry(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.diff' }
  }, 3, true)
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`)
  return res.text()
}

// Fetches all reviews for the PR and filters to bot-authored ones
async function getBotReviews () {
  const reviews = await githubGet(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews`)
  return reviews.filter(r => r.user?.login === 'github-actions[bot]' && r.body?.includes(BOT_REVIEW_MARKER))
}

// Extracts inline comments from the most recent bot review to enable re-raise logic
async function getPreviousSuggestions (botReviews) {
  if (!botReviews.length) return []

  const latest = botReviews[botReviews.length - 1]
  const comments = await githubGet(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews/${latest.id}/comments`
  )
  return comments.map(c => ({ file: c.path, line: c.line, comment: c.body }))
}

// Dismisses all previous bot reviews (CHANGES_REQUESTED and APPROVED) so the new one is the only active review
async function cleanupPreviousReviews (botReviews) {
  for (const review of botReviews) {
    if (['CHANGES_REQUESTED', 'APPROVED'].includes(review.state)) {
      const res = await fetchWithRetry(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews/${review.id}/dismissals`,
        {
          method: 'PUT',
          headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Superseded by new review' })
        },
        3, true
      )
      if (res.ok) {
        console.log(`Dismissed previous review ${review.id}`)
      } else {
        console.warn(`Failed to dismiss review ${review.id}: ${res.status} — proceeding to post new review`)
      }
    }
  }
}

// Posts the review with summary, approval state, and inline comments; falls back without inline comments on 422
async function postReview (review) {
  const { summary, approved, suggestions = [] } = review
  const event = approved ? 'APPROVE' : suggestions.length > 0 ? 'REQUEST_CHANGES' : 'COMMENT'

  let body = `## ${BOT_REVIEW_MARKER}\n\n${summary}`
  if (approved) {
    body += '\n\n✅ **LGTM!** This PR looks good to merge.'
  } else if (suggestions.length > 0) {
    const reraised = suggestions.filter(s => s.comment.startsWith('[Re-raised]')).length
    const newCount = suggestions.length - reraised
    if (reraised > 0 && newCount > 0) {
      body += `\n\n📝 **${suggestions.length} suggestion(s)** (${newCount} new, ${reraised} re-raised)`
    } else if (reraised > 0) {
      body += `\n\n🔄 **${reraised} re-raised suggestion(s)** from previous review`
    } else {
      body += `\n\n📝 **${suggestions.length} suggestion(s)** - Please review inline comments below.`
    }
  }
  body += '\n\n---\n<details>\n<summary>💡 How to re-trigger</summary>\n\nComment `/review` or `/pr-reviewer` on this PR\n</details>'

  const comments = suggestions
    .filter(s => s.file && s.line)
    .map(s => {
      const c = {
        path: s.file,
        line: s.line,
        side: 'RIGHT',
        body: s.comment + (s.suggestion ? `\n\n\`\`\`suggestion\n${s.suggestion}\n\`\`\`` : '')
      }
      if (s.start_line) {
        c.start_line = s.start_line
        c.start_side = 'RIGHT'
      }
      return c
    })

  const post = async (withComments, overrideEvent) => fetchWithRetry(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews`,
    {
      method: 'POST',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ commit_id: HEAD_SHA, body, event: overrideEvent || event, comments: withComments ? comments : [] })
    },
    3, true
  )

  let res = await post(true)

  // On 422, fall back to COMMENT without inline comments — handles both own-PR and lines-not-in-diff cases
  if (res.status === 422 && comments.length > 0) {
    console.warn('Inline comments rejected (422), retrying as COMMENT without inline comments')
    res = await post(false, 'COMMENT')
  }

  if (!res.ok) throw new Error(`Failed to post review: ${res.status} ${await res.text()}`)
  console.log(`Review posted — ${event}`)
}

// ── Bedrock / Claude ──────────────────────────────────────────────────────────

// Discovers the latest available Claude Sonnet model; prefers inference profiles (required for Claude 4.x), falls back to foundation models
async function pickLatestModel () {
  try {
    const res = await fetchWithRetry(`https://bedrock.${AWS_REGION}.amazonaws.com/inference-profiles?type=SYSTEM_DEFINED`, {
      headers: { Authorization: `Bearer ${AWS_BEARER_TOKEN_BEDROCK}` }
    })
    if (res.ok) {
      const data = await res.json()
      const profiles = (data.inferenceProfileSummaries || [])
        .filter(p => p.inferenceProfileId.includes('anthropic.claude') && p.inferenceProfileId.includes('sonnet'))
        .map(p => p.inferenceProfileId)
        .sort((a, b) => b.localeCompare(a))
      if (profiles.length) { console.log(`Model: ${profiles[0]}`); return profiles[0] }
    }
  } catch (e) {
    console.warn('Inference profiles lookup failed, trying foundation models:', e.message)
  }

  const res = await fetchWithRetry(`https://bedrock.${AWS_REGION}.amazonaws.com/foundation-models`, {
    headers: { Authorization: `Bearer ${AWS_BEARER_TOKEN_BEDROCK}` }
  })
  if (!res.ok) throw new Error(`Bedrock foundation-models error: ${res.status} ${await res.text()}`)
  const data = await res.json()
  const models = (data.modelSummaries || [])
    .filter(m => m.modelId.includes('anthropic.claude') && m.modelId.includes('sonnet') &&
      (m.inferenceTypesSupported || []).includes('ON_DEMAND'))
    .map(m => m.modelId)
    .sort((a, b) => b.localeCompare(a))
  if (!models.length) throw new Error('No Claude sonnet models available for this key')
  console.log(`Model: ${models[0]}`)
  return models[0]
}

// Calls Claude via Bedrock, parses the JSON review response
async function callClaude (diff, previousSuggestions) {
  const { system, user } = buildPrompt(diff, previousSuggestions)
  const modelId = await pickLatestModel()

  const res = await fetchWithRetry(
    `https://bedrock-runtime.${AWS_REGION}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AWS_BEARER_TOKEN_BEDROCK}` },
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 8192, system, messages: [{ role: 'user', content: user }] })
    }
  )
  if (!res.ok) throw new Error(`Bedrock error: ${res.status} ${await res.text()}`)

  const data = await res.json()
  const text = data?.content?.[0]?.text
  if (!text) throw new Error(`Unexpected Bedrock response: ${JSON.stringify(data)}`)
  if (data.stop_reason === 'max_tokens') console.warn('Bedrock hit max_tokens — review may be incomplete')
  console.log('Claude response received', { length: text.length })

  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON object found in Claude response')
  try {
    const parsed = JSON.parse(match[0])
    console.log('Claude response parsed successfully')
    return parsed
  } catch (e) {
    throw new Error(`Failed to parse Claude response as JSON: ${e.message}`)
  }
}

// Builds the prompt — instructions in system turn, diff in user turn for cleaner context boundary
function buildPrompt (diff, previousSuggestions) {
  const system = `You are a code review bot. Output RAW JSON only - no markdown, no code fences, no explanation.

Your entire response must be a valid JSON object starting with { and ending with }.

Review for: code clarity, error handling, security issues, performance, best practices.

OUTPUT FORMAT:
{"summary":"2-3 sentence assessment","approved":true,"suggestions":[]}

With suggestions:
{"summary":"...","approved":false,"suggestions":[{"file":"path/to/file.js","line":42,"comment":"Issue explanation","suggestion":"replacement code"}]}

For MULTI-LINE replacements (lines 40-45), add start_line:
{"file":"path/to/file.js","start_line":40,"line":45,"comment":"Refactor needed","suggestion":"line1\\nline2\\nline3"}

RULES:
- Output ONLY raw JSON - no markdown fences, no text before/after
- ONLY suggest changes to lines visible in the diff (+ or - lines)
- approved=true if no significant issues
- Omit suggestion field if unsure about exact line numbers
- Multi-line: line count must equal (line - start_line + 1)`

  let user = ''
  if (previousSuggestions.length > 0) {
    user += `PREVIOUS SUGGESTIONS (re-raise with "[Re-raised] " prefix if still present):\n${JSON.stringify(previousSuggestions)}\n\n`
  }
  user += `Diff:\n${diff.substring(0, 100000)}`

  return { system, user }
}

main()
