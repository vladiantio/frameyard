# Preview chrome fonts

These faces are bundled with the framework so the composition and timeline
preview pages render in a stable type system regardless of the project's own
font manifest. They are served from
`/__frameyard/framework/preview/fonts/` and are not exposed to compositions;
compositions keep using the project font sheet injected into their document
shell.

| Family | File | Weight | SHA-256 |
| --- | --- | --- | --- |
| Figtree | `figtree-latin-wght-normal.woff2` | 300–900 (variable) | `4ba7d3d096695818fe0686be4f1e82c6b05134e18a22260336130335027462dd` |
| Space Mono | `space-mono-latin-400-normal.woff2` | 400 | `fb4a81a2d0a893e5c38c394a7e716a1cef0b24610a0af49c96f6d529bd66bf2b` |
| Space Mono | `space-mono-latin-700-normal.woff2` | 700 | `2d46bd159b53f55c41167a4f1540a074649464194fd1e416f5b4694a6c0f282c` |

Sources (Fontsource 5.3.0):

- `https://cdn.jsdelivr.net/fontsource/fonts/figtree:vf@5.3.0/latin-wght-normal.woff2`
- `https://cdn.jsdelivr.net/fontsource/fonts/space-mono@5.3.0/latin-400-normal.woff2`
- `https://cdn.jsdelivr.net/fontsource/fonts/space-mono@5.3.0/latin-700-normal.woff2`

Both families are licensed under the SIL Open Font License 1.1; the license
texts are `LICENSE-figtree.txt` and `LICENSE-space-mono.txt`.
