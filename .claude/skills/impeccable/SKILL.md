---
name: impeccable
description: >-
  Design execution — implémentation UI pixel-perfect dans un design system
  existant. Use when building or modifying a page, component, layout, hero,
  card, button, form, or any rendered interface. Trigger on composant, page,
  layout, landing, dashboard, responsive, CSS, Tailwind, "refais l'écran".
---

# impeccable — exécution design

Complémentaire de `product-design` (qui décide *quoi*) : ce skill décide *comment* c'est implémenté.

## Séquence

1. **Lire avant d'écrire** — relever les tokens déjà présents : couleurs, échelle typo, échelle d'espacement, rayons, composants existants.
2. **Réutiliser** — aucune couleur ni taille inventée hors système. Si une valeur manque au système, l'ajouter explicitement plutôt que la coder en dur une fois.
3. **Justifier** — chaque valeur CSS vient d'une échelle. Zéro magic number.
4. **Mobile-first** — la base est 375px, les breakpoints ajoutent. Pas de desktop rétro-corrigé.
5. **Accessible par défaut** — contraste ≥ 4.5:1, focus visible, cible tactile ≥ 44px, `aria-*` sur tout élément interactif non natif.

## Interdit

- `transition-all` → nommer la propriété (`transition-colors`, `-opacity`, `-transform`)
- `background-clip: text` pour du texte en gradient — fragile cross-browser
- `!important` sauf contournement documenté d'un style tiers
- Hauteur fixe sur un bloc de texte
- Font `Inter` — utiliser la font du projet, sinon Outfit ou Geist

## Checklist de livraison

- [ ] Rendu vérifié à 375 / 768 / 1280
- [ ] Hover ET focus visibles sur chaque élément interactif
- [ ] Aucun débordement horizontal
- [ ] `prefers-reduced-motion` respecté
- [ ] Aucune valeur hors design system introduite
