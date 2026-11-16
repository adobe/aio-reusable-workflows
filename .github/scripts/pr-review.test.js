const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, 'pr-review.js'), 'utf8')
const review = { summary: 'No significant issues found.', approved: true, suggestions: [] }
const diff = 'diff --git a/example.js b/example.js\n--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-old()\n+updated()\n'

async function runReview (response) {
  const postedReviews = []
  const errors = []
  let exitCode
  await vm.runInNewContext(source, {
    process: {
      env: {
        GITHUB_TOKEN: 'test-github-token',
        AWS_BEARER_TOKEN_BEDROCK: 'test-bedrock-token',
        PR_NUMBER: '1',
        HEAD_SHA: 'test-head-sha',
        GITHUB_REPOSITORY: 'example/repository'
      },
      exit (code) { exitCode = code }
    },
    console: {
      log () {},
      warn () {},
      error (...args) { errors.push(args.join(' ')) }
    },
    setTimeout,
    fetch: async (url, options) => {
      if (url === 'https://api.github.com/repos/example/repository/pulls/1') {
        return new Response(diff)
      }
      if (url === 'https://api.github.com/repos/example/repository/pulls/1/reviews') {
        if (options.method === 'POST') {
          postedReviews.push(JSON.parse(options.body))
          return Response.json({})
        }
        return Response.json([])
      }
      if (url === 'https://bedrock.us-east-1.amazonaws.com/inference-profiles?type=SYSTEM_DEFINED') {
        return Response.json({
          inferenceProfileSummaries: [{ inferenceProfileId: 'us.anthropic.claude-sonnet-test' }]
        })
      }
      if (url === 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-test/invoke') {
        return Response.json(response)
      }
      throw new Error(`Unexpected request: ${url}`)
    }
  }, { filename: 'pr-review.js' })
  return { postedReviews, errors, exitCode }
}

for (const [name, content] of [
  ['a single text block', [{ type: 'text', text: JSON.stringify(review) }]],
  ['text after a non-text block', [
    { type: 'thinking', thinking: 'Do not log this reasoning.' },
    { type: 'text', text: JSON.stringify(review) }
  ]],
  ['JSON split across text blocks', [
    { type: 'text', text: '{"summary":"No significant ' },
    { type: 'text', text: 'issues found.","approved":true,"suggestions":[]}' }
  ]]
]) {
  test(`posts the review from ${name}`, async () => {
    const result = await runReview({ content, stop_reason: 'end_turn' })
    assert.equal(result.exitCode, undefined)
    assert.deepEqual(result.errors, [])
    assert.equal(result.postedReviews.length, 1)
    assert.equal(result.postedReviews[0].event, 'APPROVE')
    assert.match(result.postedReviews[0].body, /No significant issues found\./)
  })
}

for (const [name, content, blockTypes] of [
  ['missing content', undefined, 'none'],
  ['non-array content', { text: JSON.stringify(review) }, 'none'],
  ['non-text content', [{ type: 'thinking', thinking: 'Do not log this reasoning.' }], 'thinking'],
  ['whitespace-only text', [{ type: 'text', text: ' \n\t' }], 'text']
]) {
  test(`fails without posting a review for ${name}`, async () => {
    const result = await runReview({ content, stop_reason: 'end_turn' })
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.postedReviews, [])
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], new RegExp(`content block types: ${blockTypes}`))
    assert.match(result.errors[0], /stop_reason: end_turn/)
    assert.doesNotMatch(result.errors[0], /Do not log this reasoning/)
  })
}
