# chrisn-au/anylist fork

Fork of [codetheweb/anylist](https://github.com/codetheweb/anylist) (v0.8.6), used by the AnyList MCP server.

## Upstream PRs applied on branch `chris`

| PR | Title | Author | Commit here |
|----|-------|--------|-------------|
| [#56](https://github.com/codetheweb/anylist/pull/56) | Handle null meal-planning event dates | Tim Danner | `b2d919c` (cherry-picked) |
| [#57](https://github.com/codetheweb/anylist/pull/57) | feat(item): expose recipeId, rawIngredient, and ingredients properties | arunderwood | `31f08db` (cherry-picked, conflict resolved in `lib/item.js`) |

Original authorship is preserved on both commits.

Version: `0.8.6-chris.1`.

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
