These unmodified WOFF2 subsets are bundled exclusively for editable controls.

- Arimo 400 normal: `@fontsource/arimo` 5.3.0, [upstream](https://github.com/googlefonts/arimo). Arial-compatible sans serif.
- JetBrains Mono 400 normal: `@fontsource/jetbrains-mono` 5.3.0, [upstream](https://github.com/JetBrains/JetBrainsMono). The editor’s existing preferred monospace family.

Both use the SIL Open Font License; the complete licenses are included under `public/fonts/licenses/` so they are also copied into production builds. Unicode ranges come from the packages’ `400.css`. Fonts load from the app, with no external font service or `local()` lookup.

`control-fonts.css` balances the native caret around cap height using the fonts’ own metrics, preserving ascent + descent and line gap. Arimo: 2048 units/em, ascent 1854, descent 434, cap 1409, gap 67. JetBrains Mono: 1000 units/em, ascent 1020, descent 300, cap 730, gap 0. Neither the binary fonts nor typography outside editable controls is changed.

Font URLs use Vite’s `?no-inline` flag so even small subsets remain same-origin files, as required by the production `font-src 'self'` policy.
