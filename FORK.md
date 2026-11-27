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

Version: `0.8.6-chris.3`.

## Recipe photos (added in chris.3)

`recipe.setPhoto(source)` uploads a JPEG or PNG `Buffer` (max 10 MB, magic bytes checked) or an https URL, which AnyList downloads itself. It sets `recipe.photoIds` to the new id, so call `save()` afterwards. The endpoints are `data/photos/upload` (multipart `filename` + `photo`) and `data/photos/upload-url` (multipart `photo_url` + `photo_id`). Implemented in `lib/photo.js` from the observed protocol. The approach was informed by the endpoints in the zkSac/anylist-js fork (which has no licence, so no code was copied). This is verified by mocked unit tests only, not against the live service.

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
