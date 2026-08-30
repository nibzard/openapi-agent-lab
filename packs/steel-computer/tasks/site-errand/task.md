# Work request: one site errand, start to finish

Run one errand on a real website through the browser automation
service:

1. Start a session.
2. Visit https://example.com and take one action on the page.
3. Capture what the page showed: one screenshot or the page content.
4. Shut the session down.

Then answer in JSON that matches the errand result schema file in this
workspace:

- `session_created`: whether you started a session.
- `page_visited`: whether the session reached the site.
- `evidence_captured`: whether you captured the screenshot or content.
- `evidence_kind`: "screenshot" or "scrape".
- `session_released`: whether you shut the session down.

Leave no session running.
