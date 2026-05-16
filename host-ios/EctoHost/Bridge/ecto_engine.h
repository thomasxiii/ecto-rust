#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

/**
 * Opaque pointer to a heap-allocated [`Engine`]. Created with
 * [`ecto_engine_new`], freed with [`ecto_engine_free`].
 */
typedef struct Engine Engine;

/**
 * Main entry point — wraps an in-memory [`Graph`] and exposes the
 * engine's full public surface to JS.
 *
 * Every method takes `&self`. Internal mutability lives in a
 * `RefCell<Graph>` so wasm-bindgen's `WasmRefCell` only ever does
 * `borrow()`, never `borrow_mut()`. That avoids the
 * "recursive use of an object detected" trap, which can fire when
 * wasm-bindgen's RefCell sees the cell as still borrowed (e.g. after
 * a previous `&mut self` call's guard was not perfectly released).
 */
typedef struct Engine Engine;

struct Engine *ecto_engine_new(void);

void ecto_engine_free(struct Engine *engine);

/**
 * Free a string previously returned by any `ecto_*` function.
 * Safe to call on a null pointer — does nothing.
 */
void ecto_string_free(char *s);

char *ecto_engine_version(void);

char *ecto_engine_load_graph(struct Engine *engine, const char *payload_json);

char *ecto_engine_get_graph(struct Engine *engine);

char *ecto_engine_import_files(struct Engine *engine,
                               const char *project_name,
                               const char *files_json);

char *ecto_engine_apply_mutation(struct Engine *engine, const char *mutation_json);

char *ecto_engine_apply_agent_op(struct Engine *engine,
                                 const char *project_id,
                                 const char *op_json);

char *ecto_engine_walk_render_tree(struct Engine *engine, const char *root_id);

char *ecto_engine_generate_stylesheet(struct Engine *engine);

char *ecto_engine_build_semantic_layer(struct Engine *engine, const char *project_id);

char *ecto_engine_build_ui_layer(struct Engine *engine, const char *project_id);
