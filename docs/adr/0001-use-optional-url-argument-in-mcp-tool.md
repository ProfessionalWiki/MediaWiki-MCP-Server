# 1. Use optional URL argument in MCP tool

Date: 2025-06-21

## Status

Accepted.

## Context

Currently, switching between wikis requires using the stateful `set-wiki` command. To get pages from two different wikis, one must do:

```
setWiki( 'foo.example.com' )
getPage( 'Main Page' )

setWiki( 'bar.example.com' )
getPage( 'Main Page' )
```

This is cumbersome for users and LLMs, especially in conversations involving multiple wikis where the LLM needs to track the currently active wiki, which can be prone to error.

The proposed solution is to add an optional URL argument to commands, allowing for stateless calls:

```
getPage( 'Main Page', 'foo.example.com' )
getPage( 'Main Page', 'bar.example.com' )
```

This works smoothly for LLMs. If a user's initial prompt is "I have my test wiki at test.example.wiki and production at www.example.wiki", and they later say "copy the pages from the Foo category on my test wiki to production", the LLM can provide the correct arguments for all the calls without invoking extra tool calls, preventing potential errors.

## Decision

An optional `wikiUrl` argument will be added as the last parameter to all MCP tools that interact with a MediaWiki instance.

* If the `wikiUrl` argument is provided, the tool will target that wiki for the operation.
* If the argument is omitted, the tool will fall back to the wiki set by `set-wiki`, or a default wiki from the server configuration.
* The `set-wiki` tool will be retained for now as a convenience for sessions focused on a single wiki. Its long-term utility will be evaluated separately.

This decision considers the following use cases:
* **Single, locked-down wiki**: In environments like an internal corporate wiki, the wiki can be fixed in the MCP configuration. In this setup, the optional `wikiUrl` argument should be ignored.
* **Multiple wikis**: For a general-purpose "wiki helper chatbot" where wikis are not known in advance, this argument is essential.
* **Ad-hoc single wiki**: While `set-wiki` could serve this case, the optional argument is sufficient and avoids the complexity of maintaining state, especially since a single-wiki conversation can evolve to include multiple wikis.

## Consequences

### Positive
* Simplifies interactions involving multiple wikis.
* Reduces the need for the LLM to track the "current" wiki state.
* Makes interactions more robust and stateless.

### Negative
* Increases complexity in most tools. Extra code is needed to handle the current wiki.
* Requires a coordinated change across all relevant tool definitions.