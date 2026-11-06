# Quizzers for Microsoft Edge

Generated from `../extension/` by `node scripts/build-edge.js`, so don't edit files here.
Change `extension/` (or the Edge-specific overrides in `scripts/build-edge.js`) and rebuild.

## Load unpacked in Edge

1. Open **edge://extensions** in Microsoft Edge 116 or newer.
2. Turn on **Developer mode** (toggle in the left sidebar, or at the bottom of the page).
3. Click **Load unpacked** and choose this `edge-extension/` folder.
4. Click the puzzle-piece **Extensions** button in the toolbar, then the eye icon next to Quizzers to show it in the toolbar.
5. The settings page opens on first install. Paste your OpenRouter API key, pick a model, click **Test key**, then **Save**.

After changing files, rebuild, click **Reload** on the Quizzers card in edge://extensions, and refresh the course tab.

The shortcut is Alt+Shift+Q. Change it at **edge://extensions/shortcuts**.

## Publish to Edge Add-ons

1. Run `node scripts/build-edge.js --zip` to create `dist/quizzers-edge-<version>.zip`.
2. Upload the zip in [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview).

The store listing needs a privacy policy, because the extension sends question text to OpenRouter with the user's own key. See "Privacy" in the main README.

Everything else is the same as the Chrome edition: features, guardrails, permissions and tests. See the [main README](../README.md).
