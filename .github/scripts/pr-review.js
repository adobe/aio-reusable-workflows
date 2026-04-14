const BOT_REVIEW_MARKER = '🤖 PR Reviewer'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const AWS_BEARER_TOKEN_BEDROCK = process.env.AWS_BEARER_TOKEN_BEDROCK
const AWS_REGION = process.env.AWS_REGION || 'us-east-1'
const PR_NUMBER = parseInt(process.env.PR_NUMBER)
const REPO_OWNER = process.env.REPO_OWNER
const REPO_NAME = process.env.REPO_NAME
const HEAD_SHA = process.env.HEAD_SHA

async function main () {
  try {
    console.log(`Reviewing PR #${PR_NUMBER} on ${REPO_OWNER}/${REPO_NAME}`)

    const diff = await getPRDiff()
    if (!diff || diff.length < 10) { console.log('No diff to review'); return }

    const previousSuggestions = await getPreviousSuggestions()
    console.log(`Found ${previousSuggestions.length} previous suggestions`)

    const review = await callClaude(diff, previousSuggestions)

    await cleanupPreviousReviews()
    await postReview(review)

    console.log('Review posted successfully')
  } catch (err) {
    console.error('Error:', err.message)
    process.exit(1)
  }
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

async function githubGet (url) {
  const res = await fetch(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${url}`)
  return res.json()
}

async function getPRDiff () {
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.diff' }
  })
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`)
  return res.text()
}

async function getPreviousSuggestions () {
  const reviews = await githubGet(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews`)
  const botReviews = reviews.filter(r => r.body && r.body.includes(BOT_REVIEW_MARKER))
  if (!botReviews.length) return []

  const latest = botReviews[botReviews.length - 1]
  const comments = await githubGet(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews/${latest.id}/comments`
  )
  return comments.map(c => ({ file: c.path, line: c.original_line || c.line, comment: c.body }))
}

async function cleanupPreviousReviews () {
  const reviews = await githubGet(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews`)
  const botReviews = reviews.filter(r => r.body && r.body.includes(BOT_REVIEW_MARKER))

  for (const review of botReviews) {
    if (review.state === 'REQUEST_CHANGES') {
      await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews/${review.id}/dismissals`,
        {
          method: 'PUT',
          headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Superseded by new review' })
        }
      )
      console.log(`Dismissed previous review ${review.id}`)
    }
  }
}

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
      const c = { path: s.file, line: s.line, body: s.comment + (s.suggestion ? `\n\n\`\`\`suggestion\n${s.suggestion}\n\`\`\`` : '') }
      if (s.start_line) c.start_line = s.start_line
      return c
    })

  const post = async (withComments, overrideEvent) => fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews`,
    {
      method: 'POST',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ commit_id: HEAD_SHA, body, event: overrideEvent || event, comments: withComments ? comments : [] })
    }
  )

  let res = await post(true)

  if (res.status === 422 && comments.length > 0) {
    const errText = await res.text()
    if (errText.includes('own pull request')) {
      console.warn('Cannot request changes on own PR, retrying as COMMENT')
      res = await post(false, 'COMMENT')
    } else {
      console.warn('Inline comments failed, retrying without them')
      res = await post(false)
    }
  }

  if (!res.ok) throw new Error(`Failed to post review: ${res.status} ${await res.text()}`)
  console.log(`Review posted — ${event}`)
}

// ── Bedrock / Claude ──────────────────────────────────────────────────────────

async function pickLatestModel () {
  // Prefer inference profiles (required for Claude 4.x)
  try {
    const res = await fetch(`https://bedrock.${AWS_REGION}.amazonaws.com/inference-profiles?type=SYSTEM_DEFINED`, {
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

  const res = await fetch(`https://bedrock.${AWS_REGION}.amazonaws.com/foundation-models`, {
    headers: { Authorization: `Bearer ${AWS_BEARER_TOKEN_BEDROCK}` }
  })
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

async function callClaude (diff, previousSuggestions) {
  const prompt = buildPrompt(diff, previousSuggestions)
  const modelId = await pickLatestModel()

  const res = await fetch(
    `https://bedrock-runtime.${AWS_REGION}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AWS_BEARER_TOKEN_BEDROCK}` },
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] })
    }
  )
  if (!res.ok) throw new Error(`Bedrock error: ${res.status} ${await res.text()}`)

  const data = await res.json()
  const text = data.content[0].text
  console.log('Claude response preview:', text.substring(0, 200))

  try { return JSON.parse(text) } catch {
    const clean = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()
    return JSON.parse(clean)
  }
}

function buildPrompt (diff, previousSuggestions) {
  let prompt = `You are a code review bot. Output RAW JSON only - no markdown, no code fences, no explanation.

CRITICAL: Your entire response must be a valid JSON object starting with { and ending with }
DO NOT wrap in \`\`\`json or \`\`\` - output ONLY the raw JSON object.

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

  if (previousSuggestions.length > 0) {
    prompt += `\n\nPREVIOUS SUGGESTIONS (re-raise with "[Re-raised] " prefix if still present):\n${JSON.stringify(previousSuggestions)}`
  }

  prompt += `\n\nDiff:\n${diff.substring(0, 100000)}`
  return prompt
}

main()
