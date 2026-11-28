# chrisn-au/anylist fork

Fork of [codetheweb/anylist](https://github.com/codetheweb/anylist) (v0.8.6), used by the AnyList MCP server.

Install this fork (it is not on npm under its own name):

```sh
npm i github:chrisn-au/anylist#chris
```

`npm i anylist` installs the original, not this fork.

## Upstream PRs applied on branch `chris`

| PR | Title | Author | Commit here |
|----|-------|--------|-------------|
| [#56](https://github.com/codetheweb/anylist/pull/56) | Handle null meal-planning event dates | Tim Danner | `b2d919c` (cherry-picked) |
| [#57](https://github.com/codetheweb/anylist/pull/57) | feat(item): expose recipeId, rawIngredient, and ingredients properties | arunderwood | `31f08db` (cherry-picked, conflict resolved in `lib/item.js`) |

| [#58](https://github.com/codetheweb/anylist/pull/58) | reverse-engineered fix for update/create/delete recipes | Adam Ullrich | `52722b2` (cherry-picked, clean) |

Original authorship is preserved on all commits.

**Not applied from #58:** its second commit `ad939a3` ("WIP fix for meal planning") is marked WIP upstream and rewrites meal-plan date encoding to local time, which conflicts with #56's UTC date handling. Left out on purpose.

Version: `0.8.6-chris.10`.

## Recipe photos (added in chris.3)

`recipe.setPhoto(source)` uploads a JPEG or PNG `Buffer` (max 10 MB, magic bytes checked) or an https URL, which AnyList downloads itself. It sets `recipe.photoIds` to the new id, so call `save()` afterwards. The endpoints are `data/photos/upload` (multipart `filename` + `photo`) and `data/photos/upload-url` (multipart `photo_url` + `photo_id`). Implemented in `lib/photo.js` from the observed protocol. The approach was informed by the endpoints in the zkSac/anylist-js fork (which has no licence, so no code was copied). This is verified by mocked unit tests only, not against the live service.

## Fixes and additions beyond upstream

Reliability:
- A 401 retry re-sends the full request body (form bodies are buffered); before, the retry sent a drained stream and hung forever.
- Every request times out after 30 s. Concurrent token refreshes share one request.
- Websocket listener errors are caught (a network drop used to be able to crash the host process). Heartbeat timers are cleared on reconnect and close.
- `refreshOnPush: false` option: a change made in another app emits `remote-change` instead of re-fetching the whole account, so callers can batch fetches. AnyList rate-limits full fetches (`sync_rate_limited`, with `retry_after`).

Security:
- Stored credentials: scrypt + random salt + AES-256-GCM, file mode 0600, atomic writes, old files upgraded on load, nothing written without a password.
- The password and tokens are non-enumerable, so logging or serialising the client does not print them. Errors from the auth endpoints are stripped of the request (which holds the password or tokens).
- One websocket auth per client instance (it used to be shared by every client in the process).
- Photo URLs must be https without embedded credentials.
- form-data >= 4.0.5 and ws >= 7.5.14; unused tough-cookie and deprecated uuid removed (Node's `crypto.randomUUID` instead). protobufjs is still 5.0.3: `npm audit` flags it, but the advisories target the code generation in v6/v7 that v5 does not have, and the schema here is a fixed `definitions.json`. Moving to v7 is planned.

AnyList protocol:
- Photo upload (`recipe.setPhoto`): uploads are named `<id>.jpg`, as AnyList's apps do; other names attach but never display.
- Meal plan edits use `update-event`; `remove-recipe` sends `recipeIds`.
- `createList(name)`, `getRecipeCollections()`, collection add/remove name the collection and recipe ids.
- `Ingredient.identifier` and `isHeading` getters, so a recipe can be re-saved intact.
- AnyList can answer HTTP 200 and still drop a write. Read your change back before reporting success.

## Syncing with upstream

```sh
git fetch upstream
git checkout chris
git rebase upstream/master   # or: git merge upstream/master
npm test
```

Once a PR is merged upstream, drop its cherry-picked commit during the rebase.

To apply a new upstream PR:

```sh
git fetch upstream pull/<n>/head:pr-<n>
git cherry-pick $(git merge-base upstream/master pr-<n>)..pr-<n>
```
