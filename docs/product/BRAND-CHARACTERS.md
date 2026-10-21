# Kapiloto & Diego — 3D Brand Character Brief

## Goal
Create two original, highly recognizable 3D sports characters that become the marketing face of Kapiloto.

They can evoke the energy of televised sports/betting mascots and presenters, but must be original characters rather than copies of Winner or any other brand characters.

## Character roles

### Kapiloto
Role: analyst.
Personality cues:
- sharp;
- calculated;
- confident but not arrogant;
- data/strategy oriented;
- associated with purple AI intelligence.

Potential visual cues:
- tactical tablet or holographic match board;
- composed stance;
- dark/purple Dark Stadium accents.

### Diego
Role: ticket builder.
Personality cues:
- charismatic;
- energetic;
- decisive;
- slightly more playful;
- associated with cyan/teal.

Potential visual cues:
- football/stadium presenter energy;
- gesture that suggests “I built the ticket”;
- cyan/teal Dark Stadium accents.

## Visual direction
- premium stylized 3D;
- realistic materials with slightly exaggerated character proportions;
- sports-broadcast quality rather than children's-cartoon quality;
- strong silhouettes that remain recognizable at small mobile sizes;
- compatible with the Dark Stadium lighting and palette;
- transparent-background master renders preferred.

## Initial asset set
For each character:
- front hero pose;
- 3/4 pose;
- waist-up UI pose;
- celebration/success pose;
- thinking/analysis pose;
- loading/waiting pose.

Pair:
- joint login/onboarding hero composition;
- joint marketing key art.

## Product placement
Priority:
1. login/signup hero;
2. onboarding/create-or-join group;
3. Diego full-ticket flow;
4. Kapiloto analysis/recheck states;
5. selected success/empty/loading moments.

Do not place characters repeatedly inside every fixture row. The ticket remains an information-first interface.

## Performance
- use optimized WebP/AVIF or suitable real-time asset format;
- mobile page must remain usable before character art loads;
- avoid blocking authentication on character assets;
- animation is optional and should respect reduced-motion preferences.

## Next creative step
Before production assets, generate 2–3 visual directions for each character and select canonical identities. Once selected, lock a character bible for face, body, clothing, colors and poses before generating the full asset set.


## Locked brand asset architecture

The authentication artwork and the Kapiloto logo are separate assets.

### Auth hero
Canonical hero image:
`public/brand/kapiloto-auth-hero.jpg`

Rules:
- contains Kapiloto + Diego + stadium only;
- contains no baked-in logo or UI text;
- may be cropped responsively by the product;
- logo is always overlaid as a separate reusable brand component.

### Kapiloto wordmark
The official Figma component is:
`Brand/Kapiloto Wordmark`

Variants:
- Hero
- Header

Rules:
- use the same wordmark family in auth, mobile app headers and future marketing surfaces;
- do not recreate the logo as ad-hoc text;
- future exported SVG/PNG logo assets must derive from this locked component or a later explicitly approved replacement.
