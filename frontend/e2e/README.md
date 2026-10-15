Run with the project's Node version (26):

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run test:ui
```

The suite builds and serves the production app, mocks its API, and covers all 19 text input instances: chat/model search, composer, both message editors, chat/folder naming, prompt/preset/automation forms, and login. It tests normal rendering, blocked local-font access with an unusual system font, dark mode at 125% zoom, and a 2× pixel-density Chromium display. Text selection, Unicode, multiline typing, scrolling, font loading, and unchanged field height are also checked. The suite applies the production CSP and loads non-Latin font subsets to catch blocked font resources. Fonts are served by the app; no font service is used.

Chromium and WebKit screenshots include the native caret and assert its position against rendered glyph pixels. Firefox's `drawSnapshot` screenshot API omits native carets, even with `caret: 'initial'`; its automated checks verify the loaded font and ascent/descent/cap metrics instead. The actual Firefox caret was additionally checked on a Linux X display using screen capture, rather than substituting a drawn cursor. Test attachments include the field metrics.
