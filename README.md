# wasteland-plugins

Plugins for [Wasteland Next](https://github.com/alexbeatnik/WastelandNext), and the index the app installs them from.

Open **GET PLUGINS** in the left panel. The app reads [`index.json`](index.json) from this repository's `main`, lists
what is here with its icon and description, and installs on a click. Installed plugins appear in **PLUGINS** above it,
where they are switched on and off and where an **UPDATE** button shows up when a newer version is published here.

| Plugin | What it adds |
|---|---|
| [`audio-player`](plugins/audio-player) | Plays music from a folder on your machine, with a transport bar in the chat window. Reads ID3 and Vorbis tags, so it knows who performed a track even when the file name does not say. The model can start a song, build a playlist, skip and pause — and when several files could be what you meant, you get a list to click. |
| [`phosphor-themes`](plugins/phosphor-themes) | Three other screens: green phosphor, a cold cyan tube, and a paper-white daylight look with the glow switched off. |

## Two kinds of plugin

**A theme pack is data.** A manifest and some CSS, read by the app's own protocol handler. There is no code, so there
is nothing to consent to, and installing one is as consequential as changing a setting.

**Anything with a `main` is code**, and it runs in the app's main process with everything Node can reach: the
filesystem, the network, child processes. The app will not run a line of it until you switch the plugin on, and the row
you click says so. Install code from this repository or from people you have reason to trust, and read the source —
that is what it is here for.

Neither kind runs code in the chat window. The renderer executes the application's own scripts and nothing else, which
is why a plugin that wants to play audio asks the app for the `audio` service rather than shipping a player.

## Writing one

A plugin is a directory with a `plugin.json` and, if it does anything, an entry point:

```
my-plugin/
├── plugin.json
├── main.mjs        # optional — omit it for a theme pack
├── icon.svg        # optional, 24×24
└── themes/*.css    # optional
```

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "apiVersion": 2,
  "description": "One sentence, shown in the list.",
  "main": "main.mjs",
  "icon": "icon.svg",
  "actions": ["do_thing"],
  "services": ["audio"],
  "settings": [{ "key": "folder", "type": "folder", "label": "Where the things are" }],
  "themes": [{ "id": "dusk", "name": "Dusk", "file": "themes/dusk.css" }]
}
```

The `id` must match the directory name — it becomes a key in the app's config and part of a URL. Everything the plugin
can reach is declared here: an action it never listed cannot be registered, and a service it never asked for cannot be
fetched. That is deliberate, so the plugin list is a true account of what a plugin can do rather than a summary
somebody wrote.

`main.mjs` exports `activate`, and optionally `deactivate`:

```js
export function activate(ctx) {
  ctx.prompt('THING — {"type":"do_thing","steps":"<what>"}\n\nWhat the model should know about it.');

  ctx.action({
    type: 'do_thing',
    run: async (steps, turn) => {
      turn.status('Doing the thing…');
      return { ok: true, summary: 'done', feedback: '[THING] It worked. Tell the user briefly.' };
    },
  });
}
```

### What `ctx` offers

| | |
|---|---|
| `ctx.action({type, run})` | An action the model may emit. `run(steps, turn)` returns `{ok, summary, feedback}`; `feedback` is what the model reads next turn. |
| `ctx.prompt(text)` | The part of the system prompt that documents those actions. A plugin that is switched off contributes neither, so the prompt can never describe a tool that is not there. |

| `ctx.context(fn)` | Text recomputed each turn and appended to the system prompt. Include your own heading. |
| `ctx.onTurnStart(fn)` | Called once per user message. |
| `ctx.service(name)` | `audio`, `browser` or `lookupBrowser` — whichever the manifest declared. |
| `ctx.store.get(key)` | One of the settings declared in the manifest, as the user filled it in. |
| `ctx.onSettingsChanged(fn)` | Called after they edit one. |
| `ctx.log(text)` | A line in the activity log. |

`turn`, handed to `run`, has `signal` (an `AbortSignal` for Stop), `status(text)`, `log(text)` and
`confirm({command})` — which puts the app's own approval dialog in front of the user and resolves to a boolean.

### Say what your fragment prevents

Write the refusal your action exists to end, and say plainly that it is wrong in this session. Local models are
strongly disposed to explain what an assistant cannot do, and they will do it while holding the action that does it.
`audio-player` shipped a fragment that described `play_music` accurately and never said "I can't play music" was
false — and the first request to play a song got "I can't directly play music. However, I can search for it on
YouTube", from a model that had the action in front of it. The app's own lookup section learned this earlier and names
its refusal verbatim; a plugin's fragment has to do the same, especially where another section documents a plausible
wrong answer. The browser section, right beside this one, carries a worked example of playing a song on YouTube.

### The `audio` service

The app owns the `<audio>` element and the bar; the plugin owns everything that makes it a player. `audio.load({path,
label, sublabel})` puts a file in front of the user, `setTransport` says which buttons to draw and answers them, and
`play` / `pause` / `clear` do what they say. There is no queue in the service on purpose: what "next" means is the
plugin's business, and two plugins with different ideas can drive the same bar.

### Themes

A theme redefines the variables on `:root` and nothing else. It is loaded after the app's stylesheet, so equal
specificity wins on order and no `!important` is ever needed; overriding a *selector* works until the app adds a rule.
See [`green.css`](plugins/phosphor-themes/themes/green.css) for the full set of variables worth setting —
[`paper.css`](plugins/phosphor-themes/themes/paper.css) is the exception that also touches `.crt`, and says why.

## Tests

```bash
npm test
```

Runs against `tests/*.test.mjs` in plain Node — no dependencies, because the repository has none. The tag readers are
what these exist for: a binary parser fails silently, putting a wrong artist on screen rather than throwing, and the
release workflow will not publish until they pass.

A plugin cannot have `node_modules` — the app imports it by path — so anything it needs is written out here. That is
why `audio-player` carries its own ID3 and Vorbis reader instead of depending on `music-metadata`, and why it is worth
testing rather than trusting.

## Publishing

Push to `main`. [The workflow](.github/workflows/release.yml) packs every plugin into `<id>-<version>.zip`, uploads the
archives to the rolling `plugins` release, and commits a regenerated `index.json` naming each archive and its SHA-256.

The app refuses to install anything whose bytes do not match the published checksum, and refuses an archive holding a
path that would unpack outside its own directory — so an entry added by hand, without the index regenerated, simply
will not install. Bump the `version` in `plugin.json` to offer an update; the app compares numerically, so `1.10.0` is
correctly newer than `1.9.0`.

## Licence

Apache 2.0, same as the app.
