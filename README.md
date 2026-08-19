# wasteland-plugins

**The plugins that were here now live one repository each.** This one is kept for the history and for the links below;
nothing is published from it any more.

| Plugin | Repository |
|---|---|
| Browser control | [wasteland-plugin-manul-browser](https://github.com/alexbeatnik/wasteland-plugin-manul-browser) |
| Voice input | [wasteland-plugin-voice-input](https://github.com/alexbeatnik/wasteland-plugin-voice-input) |
| Audio player | [wasteland-plugin-audio-player](https://github.com/alexbeatnik/wasteland-plugin-audio-player) |
| Reminders | [wasteland-plugin-reminders](https://github.com/alexbeatnik/wasteland-plugin-reminders) |
| Space Trader | [wasteland-plugin-space-trader](https://github.com/alexbeatnik/wasteland-plugin-space-trader) |
| Українська | [wasteland-plugin-ukrainian](https://github.com/alexbeatnik/wasteland-plugin-ukrainian) |
| Phosphor themes | [wasteland-plugin-phosphor-themes](https://github.com/alexbeatnik/wasteland-plugin-phosphor-themes) |

[Wasteland Next](https://github.com/alexbeatnik/WastelandNext) ships knowing all seven, so **GET PLUGINS** lists them
without anyone pasting a URL.

## Why they were split

One index for five plugins meant a push republished all five whatever had changed, and the release history of one was
a log of the others. Browser control and Space Trader were already outside it — each carries an engine with a release
cycle of its own — so this finishes a move that was half made.

Each repository now holds its own source, its own tests, and the same release workflow: a push to `main` runs the
tests, packs `<id>-<version>.zip`, uploads it to a rolling release tagged `plugins`, commits a regenerated
`index.json` naming the archive and its SHA-256, and takes the superseded archives off. The scripts are the ones that
were in this repository, with the loop over plugins taken out.

## If you are here for an older build

[`index.json`](index.json) is now empty, and a build of the app that reads this repository as its registry will show
nothing under GET PLUGINS. Update the app, or add the repositories above in **GET PLUGINS → REGISTRIES** — pasting
`https://github.com/alexbeatnik/wasteland-plugin-audio-player` expands to the raw `index.json` on `main`.

## Writing a plugin

[docs/PLUGIN-API.md](https://github.com/alexbeatnik/WastelandNext/blob/main/docs/PLUGIN-API.md) in the app repository
is the whole of it — the manifest, every method on `ctx`, every service, and a checklist. Start a new plugin by copying
one of the repositories above: the scripts, the workflow and the tests are the same file in each, and the only thing
that differs is the id in the concurrency group.

## Licence

Apache 2.0, same as the app.
