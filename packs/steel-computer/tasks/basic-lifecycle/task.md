# Work request: one browser session, start to finish

Run one browser session through its full life with the browser automation
service:

1. Start a session.
2. Confirm through the service that the session is running.
3. Shut the session down.
4. Confirm through the service that the session is no longer running.

Then answer in JSON that matches the result schema file in this workspace:

- `session_created`: whether you started a session.
- `session_released`: whether you shut it down.
- `final_status`: the session status the service reported at the end.

Leave no session running.
