# Reference v2 plugin

This synthetic plugin exists only for local lifecycle qualification. It declares a public `label` configuration field, the scoped `reference.account` identity claim, and three tools: `read_status`, `prepare_mark`, and `execute_mark`. The execute handler increments an in-memory counter and performs no external action.

The qualification script copies these files into a fresh temporary Git repository and launches the plugin as a separate Node process. It imports the SDK from an explicit local build path supplied by that script; it does not install or publish a package.
