#!/usr/bin/env node
// SuperClaude Lite — router de COMBINAISON.
//
// Les skills s'auto-invoquent déjà via leur champ `description`, et les outils MCP
// via ToolSearch (différé par défaut). Ce hook ne sert donc qu'à une chose que le
// mécanisme natif ne fait pas : forcer les COMBINAISONS de skills qui vont ensemble,
// et signaler un MCP éteint.
//
// Il ne propose que ce qui est réellement présent sur le disque, et reste
// totalement silencieux quand rien ne matche (0 token).

const fs = require('fs')
const path = require('path')
const os = require('os')

const HOME = os.homedir()
const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const MAX_LINES = 2

// Uniquement des combinaisons : un skill seul se déclenche tout seul, inutile de le citer.
const COMBOS = [
  { key: 'ui',
    re: /design|ui\b|ux\b|maquette|landing|hero\b|layout|composant|component|typograph|palette|responsive|interface|[ée]cran/,
    skills: ['impeccable', 'taste-skill'], mcp: 'magic', reason: 'UI — exécution + goût' },

  { key: 'motion',
    re: /animation|motion|transition|easing|micro-?interaction|framer|spring|polish|feel(s)? (weird|off|good)/,
    skills: ['emil-design-eng', 'review-animations', 'animation-vocabulary'], reason: 'motion — craft + revue' },

  { key: 'research',
    re: /recherche|benchmark|compare[rz]?|tendance|trend|que disent|avis sur|state of|reddit|hacker news/,
    skills: ['web-research'], cli: 'agent-reach', reason: 'recherche multi-source' },

  { key: 'growth',
    re: /landing|campagne|cro\b|conversion|funnel|ad copy|copywriting|growth|a\/b|value prop|seo\b/,
    skills: ['marketing-growth'], reason: 'growth' },

  { key: 'orchestr',
    re: /orchestr|multi-?agent|d[ée]compose|audit exhaustif|migration|grande [ée]chelle|exhaustif/,
    skills: ['context-engineering'], reason: 'orchestration multi-agent' },
]

// --- Inventaire disque -------------------------------------------------------
function skillDirs(root, depth) {
  const out = []
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = path.join(root, e.name)
    if (fs.existsSync(path.join(p, 'SKILL.md'))) out.push(e.name)
    else if (depth > 0) out.push(...skillDirs(p, depth - 1))
  }
  return out
}

function installedSkills() {
  const s = new Set()
  for (const n of skillDirs(path.join(HOME, '.claude', 'skills'), 1)) s.add(n)
  for (const n of skillDirs(path.join(PROJECT, '.claude', 'skills'), 1)) s.add(n)
  const cache = path.join(HOME, '.claude', 'plugins', 'cache')
  for (const mk of subdirs(cache)) {
    for (const pl of subdirs(path.join(cache, mk))) {
      for (const n of skillDirs(path.join(cache, mk, pl, 'skills'), 0)) s.add(n)
    }
  }
  return s
}

function subdirs(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) }
  catch { return [] }
}

function installedMcp() {
  const s = new Set()
  for (const f of [path.join(HOME, '.claude.json'), path.join(PROJECT, '.mcp.json')]) {
    try { Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).forEach(k => s.add(k)) } catch {}
  }
  return s
}

// --- Main --------------------------------------------------------------------
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  let input = {}
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
  const msg = String(input.prompt || input.message || '').toLowerCase()
  if (!msg) return

  const hits = COMBOS.filter(c => c.re.test(msg))
  if (!hits.length) return

  const skills = installedSkills()
  const mcps = installedMcp()
  const lines = []

  for (const c of hits) {
    const have = c.skills.filter(n => skills.has(n))
    if (!have.length) continue
    const parts = [have.map(n => `Skill(${n})`).join(' + ')]
    if (c.mcp && !mcps.has(c.mcp)) parts.push(`MCP ${c.mcp} éteint → \`sc mcp ${c.mcp} on\``)
    if (c.cli) parts.push(`CLI ${c.cli}`)
    lines.push(`  → ${parts.join(' · ')}  [${c.reason}]`)
    if (lines.length >= MAX_LINES) break
  }

  if (!lines.length) return
  console.log('⚡ Combiner:')
  console.log(lines.join('\n'))
})
