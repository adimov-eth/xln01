| Area                 | Fix                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **Performance**      | `validateCommit()` replays txs every time; cache `frame.hash → stateHash` to skip duplicates. |
| **Security**         | Delete `DEV_SKIP_SIGS` flag in production; always verify BLS aggregate.                       |
| **Error signalling** | Replace silent `return rep` with explicit error codes/logging for failed validation.          |
