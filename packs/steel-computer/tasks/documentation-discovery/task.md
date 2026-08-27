# Task: discover the API, then create exactly one session

The workspace contains the API description file `{{api.contractFile}}` for
the service at {{api.baseUrl}}.

1. Read `{{api.contractFile}}` and determine how sessions are created.
2. Create exactly one session, using a request shape the description
   actually supports.
3. Do not send requests to routes the description does not declare.

Then answer in JSON that matches `result.schema.json`:

- `session_created`: whether one session exists.
- `operations_discovered`: how many operations the description declares.
- `contract_source`: the file name you used as the source of truth.
