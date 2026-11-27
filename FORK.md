# chrisn-au/anylist fork

Fork of [codetheweb/anylist](https://github.com/codetheweb/anylist) (v0.8.6), used by the AnyList MCP server.

## Upstream PRs applied on branch `chris`

| PR | Title | Author | Commit here |
|----|-------|--------|-------------|
| [#56](https://github.com/codetheweb/anylist/pull/56) | Handle null meal-planning event dates | Tim Danner | `b2d919c` (cherry-picked) |
| [#57](https://github.com/codetheweb/anylist/pull/57) | feat(item): expose recipeId, rawIngredient, and ingredients properties | arunderwood | `31f08db` (cherry-picked, conflict resolved in `lib/item.js`) |

| [#58](https://github.com/codetheweb/anylist/pull/58) | reverse-engineered fix for update/create/delete recipes | Adam Ullrich | `52722b2` (cherry-picked, clean) |

Original authorship is preserved on all commits.

**Not applied from #58:** its second commit `ad939a3` ("WIP fix for meal planning") is marked WIP upstream and rewrites meal-plan date encoding to local time, which conflicts with #56's UTC date handling. Left out on purpose.

Version: `0.8.6-chris.2`.

## Recipe photos

The protobuf `PBRecipe` has `photoIds` and `photoUrls` (repeated strings), and the library passes them through. No upload endpoint for recipe photos exists in this library, its protobufs or upstream issues/PRs, so the fork cannot store a new photo yet. Setting `photoUrls` is untested against the real AnyList service.

## Tests

- `npm test`: mocked unit tests in `test/unit/` (no network, no credentials).
- `npm run test:integration`: the upstream suite in `test/`. It logs into a real AnyList account and needs `ANYLIST_USERNAME` / `ANYLIST_PASSWORD`.

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
