# Work request: two clips through the webclip service

Run one errand against the web clip service:

1. Clip https://example.com/essay as markdown.
2. Clip https://example.com/dashboard as an image.
3. Render both clips.
4. Fetch the content of each clip with the right Accept header.
5. Extract the text of the markdown clip.
6. Delete the markdown clip.
7. Check the account quota.

Then answer in JSON that matches the result schema file in this
workspace:

- `clips_created`: whether you created both clips.
- `markdown_clipped`: whether the essay clip exists in markdown form.
- `image_clipped`: whether the dashboard clip exists in image form.
- `both_rendered`: whether both renders finished.
- `markdown_content_fetched`: whether you fetched the markdown content.
- `image_content_fetched`: whether you fetched the image content.
- `text_extracted`: whether you extracted the markdown clip's text.
- `clip_deleted`: whether you deleted the markdown clip.
- `quota_checked`: whether you read the account quota.
- `api_model`: describe the API in your own words. Say what it does and
  how its resources relate. Write only what you observed while working.
- `authentication_model`: describe how a client proves its identity to
  this service.
- `uncertainties`: list what stayed unclear while you worked.

Leave the markdown clip deleted and the image clip in place.
