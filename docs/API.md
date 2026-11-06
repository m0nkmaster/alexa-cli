# Unofficial Alexa API Notes

## Rename a smart-home endpoint

`alexa-cli rename "Old name" "New name"` uses the authenticated app GraphQL endpoint at
`/nexus/v1/graphql`. Use `--dry-run` to resolve without mutating, or `--endpoint-id <id>` to
select one exact endpoint when friendly names are ambiguous.

```graphql
mutation RenameEndpointFriendlyName($input: SetEndpointFriendlyNameInput!) {
  setEndpointFriendlyName(input: $input) {
    endpoint { id friendlyNameObject { value { text } } }
  }
}
```

Variables are `{ "input": { "endpointId": "amzn1.alexa.endpoint.…", "friendlyName": "New name" } }`.
The command reports success only when the response returns the requested endpoint ID and friendly name;
GraphQL errors, missing data, or mismatched confirmation are failures.
