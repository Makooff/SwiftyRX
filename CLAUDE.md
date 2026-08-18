<!-- Adapted from https://github.com/Makooff/SuperClaude (lite edition, MIT) -->
<!-- superclaude-lite:start -->
# SuperClaude Lite

## Constant
`superpowers` (brainstorm, plans, debug, TDD, git) · `caveman` (réponses compressées) · `Skill(context-engineering)` (déléguer la lecture lourde aux sous-agents) · `claude-mem` (mémoire cross-session, 5 hooks automatiques) · `code-review`.

Rien d'autre n'est chargé d'avance.

## Auto — zéro coût avant usage
Les skills s'invoquent seuls via leur description. Les outils MCP sont **différés** (ToolSearch) : seuls leurs noms chargent, les schémas arrivent au moment de l'appel.

| Quand | Ce qui s'active |
|---|---|
| UI, écran, composant, landing | `impeccable` + `taste-skill` |
| animation, motion, easing | `emil-design-eng` + `review-animations` + `animation-vocabulary` |
| recherche, comparatif, tendance | `web-research` + CLI `agent-reach` |
| landing, CRO, funnel, SEO, copy | `marketing-growth` |
| tâche large, multi-fichiers, audit | `context-engineering` |
| doc d'une lib précise | MCP `context7` |
| navigateur, E2E, screenshot | MCP `playwright` |
| issues, PR, CI | MCP `github` |
| deploy, env vars, logs | MCP `vercel` |
| DB, auth, edge functions | MCP `supabase` |
| paiements, webhooks | MCP `stripe` |

`impeccable` exécute, `taste-skill` arbitre le visuel — les deux ensemble, jamais l'un sans l'autre sur une tâche UI.

## Bascules
`sc status` · `sc mcp <nom> on|off` · `sc plugin vercel on` (ajoute ses 34 skills : ~3800 tokens permanents — à n'allumer que le temps d'un projet Vercel).

## Économie
Lecture lourde, exploration, mapping → sous-agent : garder la conclusion, pas les extraits. Ne pas relire un fichier déjà édité. Ne pas relancer une recherche déjà déléguée.

## Output
Réponses courtes. Zéro prose de remplissage. Pas de résumé sauf demandé. Commentaire de code seulement pour un WHY non évident.

## Design — interdictions
Pas de `transition-all`, `background-clip:text`, font Inter, glassmorphism. Easing `cubic-bezier(0.16,1,0.3,1)`. Press `scale(0.97)`.

## Commits
`feat|fix|refactor: description` — pas de `Co-Authored-By`.
<!-- superclaude-lite:end -->
