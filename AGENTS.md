# AGENTS.md - js-callgraph Project Documentation

## Project Overview

**js-callgraph** is a static analysis tool that constructs call graphs for JavaScript projects using a field-based algorithm. It analyzes JavaScript source code to determine which functions call which other functions, supporting modern JavaScript features and multiple module systems.

The tool traces data flow to determine which functions can be called from which call sites, producing a graph that maps call sites ("callers") to their potential target functions ("callees").

### Key Features
- ES6+ support (arrow functions, destructuring, classes, enhanced object literals, rest/spread)
- TypeScript support
- Module systems: ES6 (`import`/`export`), CommonJS (`require`/`module.exports`), AMD (`define`)
- JSX and Vue.js support (.vue files)
- Multiple analysis strategies (NONE, ONESHOT, DEMAND, FULL)
- JSON output format for call graph representation
- Native function modeling for built-in JavaScript APIs
- Contextual callback naming (`clb(functionName)` pattern) for improved readability
- Smart function naming with anonymous function indexing

### Research Foundation
Based on the paper: "Efficient Construction of Approximate Call Graphs for JavaScript IDE Services" (ICSE 2013)

## Domain

**Static Analysis for JavaScript Call Graphs**

The tool performs static analysis on JavaScript/TypeScript codebases to extract call relationships between functions. It uses a field-based approach where properties are identified only by name, which means like-named properties of different objects are conflated. This can lead to imprecision but enables scalable analysis.

### Limitations
- Dynamic property reads/writes are ignored
- Reflective calls using `call` and `apply` are not tracked
- Call graphs are intrinsically incomplete due to JavaScript's dynamic nature
- Field-based approach conflates properties with the same name across different objects

## Architecture

The tool follows a multi-stage pipeline architecture, orchestrated by `runner.js`:

```
Source Files → Parse (AST) → Bind → Flow Graph → Call Graph → JSON Output
```

### Pipeline Stages

1. **Parse & Preprocessing**: Convert JavaScript/TypeScript/JSX/Vue files into ASTs using `@typescript-eslint/typescript-estree`
   - Source files are read from disk
   - `srcPreprocessor.js` cleans the source (e.g., stripping hashbangs, handling Vue single-file components)
   - Parse each file into an AST with location and range information

2. **AST Initialization**: Set up metadata on AST nodes
   - `astutil.init()` traverses the AST to find all function declarations/expressions and call sites
   - Cache them at the root (`root.attr.functions`, `root.attr.calls`)
   - Track enclosing functions and files
   - Initialize `attr` fields for attaching metadata to nodes
   - Detect callback contexts for anonymous functions:
     - Track array parent relationships to identify callback arguments
     - Mark functions as callbacks when passed as arguments to calls
     - Store callback metadata: `isCallback`, `callbackCallNode`, `callbackArgumentIndex`, `callbackFunctionArgsCount`, `callbackFunctionPosition`
   - Assign anonymous function indices for non-callback anonymous functions

3. **Binding Resolution**: Resolve name bindings for lexical variables
   - `bindings.addBindings()` builds a **Symbol Table** (`Symtab`) for each scope
   - Resolve variable references to their declarations
   - Handle different scoping rules (function scope, block scope, catch clause scope)
   - Handle destructuring patterns (array and object patterns)
   - Manage imports/exports
   - Connect identifiers to their declaration nodes (`nd.attr.scope`)

4. **Flow Graph Construction**: Build intraprocedural flow graphs showing how values flow within functions
   - Create a central `FlowGraph` instance to model data flow
   - `flowgraph.addIntraproceduralFlowGraphEdges()` adds intraprocedural flow edges based on AST structure
   - Create vertices for different program entities (variables, properties, functions, calls)
   - Add edges representing data flow based on AST node types (e.g., assignments, property accesses)
   - Implement the formal flow rules from the research paper (R1-R9)
   - `natives.addNativeFlowEdges()` adds vertices for built-in JavaScript functions and connects them
   - `module.js` analyzes module statements and adds inter-module flow edges

5. **Interprocedural Analysis** (Strategy-Dependent): Connect function calls to function definitions
   - **NONE/ONESHOT** → `pessimistic.js`: Simpler, faster strategy
     - Connects "one-shot" calls (IIFEs) directly
     - Pessimistically assumes parameters flow from `UnknownVertex`
     - Return values can flow to `UnknownVertex`
   - **DEMAND** → `semioptimistic.js`: More precise, slower strategy
     - Iteratively propagates flow using Depth-First Transitive Closure
     - Only propagates flow that can reach call sites
     - Repeats until a fixpoint is reached

6. **Call Graph Extraction**: Extract interprocedural call relationships from flow graphs
   - `callgraph.extractCG()` takes the final, fully populated `FlowGraph`
   - Compute reachability using `dftc.reachability()`
   - For each `FuncVertex`, find reachable `CalleeVertex` nodes
   - Build call graph edges
   - Track escaping functions (those that flow to unknown vertices)
   - Identify unknown call sites (called from unknown context)
   - Returns object with edges, escaping functions, and unknown calls

7. **Edge Extraction**: Format edges based on analyzer type
   - `retrieveAllCalledFunctionsStatic`: For static analyzer (excludes native calls)
   - `retrieveAllCalledFunctionsNative`: For native analyzer (tracks callback functions)
   - `retrieveAllCalledFunctionsACG`: For ACG analyzer (basic call graph)

8. **Output Generation**: Serialize call graph into unified JSON format
   - Serialize to JSON
   - Write to file or console
   - Format: Array of {source, target} objects with location info

## Main Components

### 1. Entry Points

#### `js-callgraph.js` (CLI)
- Command-line interface for the tool
- Parses arguments and invokes runner module
- Binary entry point specified in package.json

#### `index.js` (Programmatic API)
- Exports runner module for use as a library
- Allows integration into other tools

### 2. Core Modules

#### `src/runner.js`
**Main orchestrator for the call graph construction pipeline**

Key responsibilities:
- Manages the overall workflow
- Handles file collection and filtering
- Coordinates parsing, binding, and call graph construction
- Produces output in multiple formats (console, JSON)
- Implements three different edge extractors for different analyzer types

Key functions:
- `setFiles()`: Configure input files/directories
- `setFilter()`: Apply regex filters to files
- `setArgs()`: Set analysis options (strategy, output format, etc.)
- `build()`: Execute the analysis pipeline (main entry point)

Execution flow:
1. Call `astutil.astFromFiles(files)` to get the AST
2. Call `bindings.addBindings(ast)` to resolve scopes
3. Choose strategy based on `args.strategy`:
   - 'ONESHOT' or 'NONE': Call `pessimistic.buildCallGraph(ast)`
   - 'DEMAND': Call `semioptimistic.buildCallGraph(ast)`
4. Format and output the call graph edges

#### `src/astutil.js`
**AST parsing and traversal utilities**

Key responsibilities:
- Parse JavaScript/TypeScript/JSX/Vue files into ASTs using `@typescript-eslint/typescript-estree`
- Provide AST traversal utilities (`visit`, `visitWithState`)
- Set up `attr` fields for attaching metadata to nodes
- Track enclosing functions and files
- Handle function naming (including anonymous functions, arrow functions, class methods)
- Detect and name callback functions contextually
- Preprocess Vue.js single-file components

Key functions:
- `astFromFiles()`: Parse multiple files into a single AST
- `visit()`: Traverse AST with visitor pattern
- `visitWithState()`: Traverse AST with stateful visitor
- `init()`: Initialize AST attributes (enclosingFunction, enclosingFile, etc.), cache functions and calls
- `funcname()`: Extract function names with fallbacks and callback naming
- `encFuncName()`: Get enclosing function name
- `ppPos()`: Pretty-print position information
- `buildMemberExpressionName()`: Build names from MemberExpression chains (e.g., "obj.prop.method")
- `getCalleeName()`: Extract function name from CallExpression nodes

Function naming strategy:
- Named functions use their declared name
- Anonymous functions assigned to variables use the variable name
- Anonymous callback functions use `clb(functionName)` pattern (single callback) or `clb(functionName)[N]` (multiple callbacks)
- Other anonymous functions use `parentFunction:anon[N]` pattern

#### `src/bindings.js`
**Name binding resolution for lexical variables**

Key responsibilities:
- Build symbol tables for each scope
- Resolve variable references to their declarations
- Handle different scoping rules (function scope, block scope, catch clause scope)
- Track binding information for identifiers
- Handle destructuring patterns (array and object patterns)
- Manage imports/exports

Key functions:
- `addBindings()`: Main entry point to add bindings to AST
- Creates nested `Symtab` instances for each scope
- Handles special cases: function parameters, `this`, `arguments`, catch clauses
- Attaches scope information to AST nodes (`nd.attr.scope`)

#### `src/symtab.js`
**Symbol table implementation**

Key responsibilities:
- Store mappings from variable names to their declaration nodes
- Support nested scopes with outer scope references
- Distinguish between global and local scopes
- Provide lookup with scope chain traversal

Key methods:
- `set()`: Add a binding to the current scope
- `get()`: Look up a binding (traverses scope chain)
- `hasOwn()`: Check if binding exists in current scope (not outer)

Data structure:
- Simple, chained symbol table
- Maps variable names within a scope to their corresponding AST declaration node

#### `src/flowgraph.js`
**Intraprocedural flow graph construction**

Key responsibilities:
- Build flow graphs showing how values flow within and between functions
- Create vertices for different program entities (variables, properties, functions, calls)
- Add edges representing data flow based on AST structure
- Handle all JavaScript expression and statement types
- Implement the formal flow rules from the research paper (R1-R9)

Vertex types:
- `VarVertex`: Represents variables/variable declarations
- `GlobVertex`: Represents global variables
- `PropVertex`: Represents property accesses
- `FuncVertex`: Represents function definitions
- `CalleeVertex`: Represents call sites (the function being called)
- `ArgVertex`: Represents function arguments at call sites
- `ResVertex`: Represents function return values at call sites
- `RetVertex`: Represents `return` statement values
- `ExprVertex`: Represents expressions
- `UnknownVertex`: Singleton representing unknown/external values (sink/source for unmodeled data flow)
- `NativeVertex`: Represents native functions (built-in JavaScript functions)

Key functions:
- `addIntraproceduralFlowGraphEdges()`: Build intraprocedural flow graph from AST
- `vertexFor()`: Get or create vertex for an AST node
- Various vertex constructors: `varVertex()`, `propVertex()`, `funcVertex()`, etc.

#### `src/callgraph.js`
**Call graph extraction from flow graphs**

Key responsibilities:
- Extract call relationships from flow graphs
- Use reachability analysis to determine which functions can reach which call sites
- Track escaping functions (those that flow to unknown vertices)
- Identify unknown call sites (called from unknown context)

Key functions:
- `extractCG()`: Main extraction function
  - Takes the final, fully populated `FlowGraph`
  - Computes reachability using `dftc.reachability()`
  - Uses transitive closure to find all `FuncVertex` nodes reachable from each `CalleeVertex` node
  - Processes each `FuncVertex` to find reachable `CalleeVertex` nodes
  - The final set of `(CalleeVertex, FuncVertex)` pairs is the call graph
  - Returns object with edges, escaping functions, and unknown calls

#### `src/pessimistic.js`
**Pessimistic call graph builder**

Key responsibilities:
- Implement NONE and ONESHOT strategies
- Build call graph with no interprocedural flow (NONE) or limited interprocedural flow (ONESHOT)
- Handle one-shot closures (immediately invoked functions / IIFEs)

Strategies:
- **NONE**: No interprocedural propagation at all
- **ONESHOT**: Tracks interprocedural flow only for immediately invoked closures

Key functions:
- `buildCallGraph()`: Build pessimistic call graph
  - Creates new `FlowGraph`
  - Calls `natives.addNativeFlowEdges(fg)`
  - Constructs intraprocedural flow graph
  - Optionally adds edges for one-shot closures
  - Adds edges for native functions
  - Calls `callgraph.extractCG(ast, fg)` to extract and return call graph

#### `src/semioptimistic.js`
**Optimistic call graph builder**

Key responsibilities:
- Implement DEMAND strategy
- Perform interprocedural propagation along edges that may reach call sites
- More precise than pessimistic but more expensive
- Iteratively propagates flow until fixpoint is reached

Strategy:
- **DEMAND**: Propagates flow information to call sites as needed
  - Only propagates flow that is "interesting" (can reach a call site)
  - Uses Depth-First Transitive Closure for reachability

Key functions:
- `buildCallGraph()`: Build optimistic call graph using demand-driven analysis
  - Creates new `FlowGraph`
  - Calls `natives.addNativeFlowEdges(fg)`
  - Calls `flowgraph.addIntraproceduralFlowGraphEdges(ast, fg)`
  - Handles modules and adds interprocedural flow (`addInterproceduralFlowEdges`)
  - Calls `callgraph.extractCG(ast, fg)` to extract and return call graph

#### `src/graph.js`
**Graph data structure implementations**

Key responsibilities:
- Provide efficient graph representations
- Support adding/removing nodes and edges
- Implement graph algorithms (serialization, iteration)
- Adjacency-list-based graphs using `linkedList.js`

Graph types:
- `BasicGraph`: Basic directed graph
- `Graph`: General directed graph with adjacency sets
- `FlowGraph`: Specialized for flow graph representation

Key classes:
- `Graph`: General graph implementation
  - `addEdge()`, `addEdges()`: Add edges
  - `iter()`: Iterate over edges
  - `iterNodes()`: Iterate over nodes
  - `serialize()`: Convert to serializable format

#### `src/natives.js`
**Native function modeling**

Key responsibilities:
- Model behavior of built-in JavaScript functions
- Add flow edges for native functions that take callbacks
- Handle Array methods (forEach, map, filter, etc.)
- Handle Promise methods
- Handle setTimeout/setInterval
- Handle Object methods
- Handle Function.prototype methods
- Handle `step` library (`Step`) for controlling async flow and sequential callback execution

Key functions:
- `addNativeFlowEdges()`: Add flow edges for native callback-accepting functions
  - Implements flow for: Array.prototype methods, Function.prototype methods, Promise methods, timer functions, etc.
  - Adds vertices for built-in functions (defined in `harness.js`)
  - Connects them to their corresponding property vertices (e.g., `NativeVertex('Math_log')` → `PropVertex('log')`)
- `addStepFlowEdges()`: Add flow edges for `step` npm package calls
  - Detects `Step(fn1, fn2, fn3, ...)` calls for async flow control
  - Creates sequential call chain edges: `fn1 → fn2 → fn3` to model linearized callbacks
  - Connects each function's return to the next function's call site
  - Models the sequential execution pattern without self-loops

#### `src/harness.js`
**Native function definitions**

Key responsibilities:
- Lists native JavaScript functions
- Provides function signatures for built-in APIs
- Used by `natives.js` to model native function behavior
- Defines `Step` for the `step` npm package (async flow control library)

#### `src/module.js`
**Module import/export handling**

Key responsibilities:
- Resolve ES6 imports/exports
- Handle CommonJS require/module.exports
- Handle AMD define/require
- Track module dependencies
- Build module graph
- Resolve module specifiers to file paths
- Add inter-file flow edges

Key functions:
- `collectExportsImports()`: Analyze module-related statements
- `connectImports()`: Add flow edges between modules
- Handles `ImportDeclaration`, `ExportDeclaration`, `require()` calls
- Resolves relative and absolute module paths

### 3. Supporting Modules

#### `src/dftc.js`
**Depth-First Transitive Closure algorithm**

- Computes reachability in directed graphs using depth-first search
- Used by call graph extraction to find which functions reach which call sites
- Default transitive closure implementation (simpler and faster than alternatives)
- Key algorithm used by analysis strategies
- Fundamental to determining which vertices are reachable from each vertex in the flow graph

#### `src/utils.js`
**Utility functions**

- File collection from directories
- Path manipulation
- General helper functions

#### `src/diagnostics.js`
**Diagnostic utilities**

- Error reporting
- Warning generation
- Debug output

#### `src/requireJsGraph.js`
**RequireJS dependency graph builder**

- Specialized analysis for RequireJS-based projects
- Builds dependency graph based on `define()` and `require()` calls

#### `src/callbackCounter.js`
**Callback counting utilities**

- Count callbacks in code
- Statistical analysis of callback usage

#### `src/srcPreprocessor.js`
**Source preprocessing**

- Handle Vue.js single-file components
- Extract script sections from Vue files
- Strip hashbangs and other preprocessing tasks
- Preprocess source before parsing

#### `src/set.js`
**Set implementation**

- Generic set data structure
- Used throughout for efficient membership testing

#### `src/linkedList.js`
**Linked list implementation**

- Used in graph algorithms
- Used by graph data structures for adjacency lists

## Key Entities

### AST Nodes

The raw output from the parser (`@typescript-eslint/typescript-estree`). These nodes are heavily **decorated with attributes** (in `nd.attr`) during analysis:

- `nd.attr.scope`: Points to the `Symtab` for the node's scope
- `nd.attr.enclosingFunction`: Points to the AST node of the surrounding function
- `nd.attr.enclosingFile`: File path for the node
- `nd.attr.var_vertex`, `nd.attr.func_vertex`, etc.: Caches for corresponding flow graph vertices

### Vertex Types (Flow Graph Nodes)

1. **VarVertex**: Represents a variable reference/declaration
   - Contains reference to identifier AST node
   - Key: variable name + scope

2. **GlobVertex**: Represents a global variable
   - Similar to VarVertex but for global scope

3. **PropVertex**: Represents a property access (e.g., `obj.prop`)
   - Contains property name
   - Identified by property name (field-based approach)

4. **FuncVertex**: Represents a function definition
   - Contains reference to function AST node
   - Represents the function as a value

5. **CalleeVertex**: Represents a call site
   - Contains reference to call expression AST node
   - Represents the callee position of a call (the function being called)

6. **ArgVertex**: Represents a function argument at a call site
   - Contains call node and argument index
   - Represents value passed as argument

7. **ResVertex**: Represents a function return value at a call site
   - Contains call node
   - Represents value returned from call

8. **RetVertex**: Represents a `return` statement's value
   - Contains return statement node

9. **ExprVertex**: Represents a general expression
   - Contains expression AST node
   - Represents computed value

10. **UnknownVertex**: Singleton representing unknown/external values
    - Used for values that escape or come from outside
    - Sink/source for unmodeled data flow
    - Used heavily in the pessimistic strategy

11. **NativeVertex**: Represents a native JavaScript function
    - Contains function name
    - Used for built-in functions (Array.prototype.map, Math.log, etc.)

### Graph Structures

1. **FlowGraph**: Directed graph of vertices with edges representing data flow
   - Nodes: Various vertex types
   - Edges: Data flow relationships
   - Central data structure for the analysis

2. **CallGraph**: Directed graph showing function calls
   - Nodes: CalleeVertex (call sites) and FuncVertex (functions)
   - Edges: Caller → Callee relationships
   - Additional info: escaping functions, unknown calls

### Symbol Tables (Symtab)

- Nested structure representing lexical scopes
- Maps variable names to declaration nodes
- Links to outer scope for scope chain resolution
- Simple, chained symbol table implementation

## Data Flow

### Main Pipeline

```
1. File Input
   ↓
2. File Collection & Filtering (runner.js)
   - Collect .js, .jsx, .ts, .tsx, .vue files
   - Apply regex filters if specified
   ↓
3. Parsing & Preprocessing (astutil.js, srcPreprocessor.js)
   - Clean source (strip hashbangs, handle Vue files)
   - Parse each file using @typescript-eslint/typescript-estree
   - Merge into single AST with location and range information
   ↓
4. AST Initialization (astutil.js)
   - Initialize attributes (enclosingFunction, enclosingFile)
   - Cache functions and call sites at root (root.attr.functions, root.attr.calls)
   ↓
5. Binding Resolution (bindings.js)
   - Create symbol tables for each scope
   - Resolve variable references to declarations
   - Handle destructuring, imports/exports
   - Attach scope information to nodes
   ↓
6. Flow Graph Construction
   - Strategy: NONE/ONESHOT → pessimistic.js
   - Strategy: DEMAND → semioptimistic.js
   
   6a. Create FlowGraph instance
   
   6b. Add Native Functions (natives.js)
       - Add vertices for built-in functions from harness.js
       - Connect to property vertices
   
   6c. Intraprocedural Flow (flowgraph.js)
       - Create vertices for program entities
       - Add edges based on AST structure (R1-R9)
       - Handle all expression and statement types
   
   6d. Module Analysis (module.js)
       - Analyze import/export statements
       - Add inter-module flow edges
   
   6e. Interprocedural Flow (strategy-dependent)
       - NONE: No interprocedural edges
       - ONESHOT: Edges for immediately invoked functions (IIFEs)
       - DEMAND: Iterative demand-driven interprocedural propagation
         - Uses dftc.js for reachability
         - Propagates only "interesting" flow
         - Repeats until fixpoint
   ↓
7. Call Graph Extraction (callgraph.js)
   - Compute reachability using dftc.reachability()
   - For each FuncVertex, find reachable CalleeVertex nodes
   - Build call graph edges (CalleeVertex, FuncVertex) pairs
   - Track escaping functions and unknown calls
   ↓
8. Edge Extraction (runner.js)
   - Extract relevant edges based on analyzer type
   - Format edge information with buildBinding
   ↓
9. Output Generation (runner.js)
   - Serialize to JSON
   - Write to file or console
   - Format: Array of {source, target} objects with location info
```

### Analysis Strategies

#### NONE (Pessimistic)
- No interprocedural propagation
- Fastest but least precise
- Only tracks intraprocedural flow
- Parameters flow from `UnknownVertex`
- Return values flow to `UnknownVertex`

#### ONESHOT (Pessimistic)
- Tracks flow for immediately invoked closures (IIFEs)
- Connects "one-shot" calls directly
- Moderate precision
- Good balance for many use cases
- Default strategy

#### DEMAND (Optimistic)
- Demand-driven interprocedural propagation
- Propagates flow to call sites as needed
- Only propagates "interesting" flow (can reach call sites)
- More precise but more expensive
- Iterative algorithm using DFTC
- Repeats until fixpoint is reached
- Recommended for thorough analysis

#### FULL (Not Implemented)
- Would perform full interprocedural propagation
- Currently falls back to DEMAND

## Usage Patterns

### CLI Usage

```bash
# Basic call graph
jscg --cg path/to/file.js

# Analyze directory
jscg --cg path/to/directory/

# Save to file
jscg --cg input.js --output result.json

# Use specific strategy
jscg --cg input.js --strategy DEMAND

# Apply filter
jscg --cg directory/ --filter filter.txt

# Show timing information
jscg --cg input.js --time
```

### Programmatic Usage

```javascript
const JCG = require("./src/runner");

// Configure
JCG.setArgs({ 
  strategy: 'DEMAND',
  cg: true,
  output: ['output.json']
});

JCG.setFiles(['src/', 'lib/utils.js']);
JCG.setFilter(['-test*.js', '+test123.js']);
JCG.setConsoleOutput(true);

// Build call graph
const result = JCG.build();
// result is array of {source, target} edge objects
```

## Output Format

### JSON Structure

```json
[
  {
    "source": {
      "label": "functionName",
      "file": "/path/to/file.js",
      "start": { "row": 10, "column": 5 },
      "end": { "row": 15, "column": 1 },
      "range": { "start": 234, "end": 456 }
    },
    "target": {
      "label": "calledFunction",
      "file": "/path/to/other.js",
      "start": { "row": 3, "column": 0 },
      "end": { "row": 8, "column": 1 },
      "range": { "start": 45, "end": 123 }
    }
  }
]
```

### Edge Properties

- **label**: Function name (or "global" for top-level)
- **file**: Absolute path to source file (or "Native" for built-ins)
- **start/end**: Line and column positions
- **range**: Character offset positions (start and end character offsets)

### Function Naming Examples

The tool uses intelligent naming for anonymous functions based on context:

**Named Functions:**
```javascript
function myFunction() { }
// Label: "myFunction"
```

**Variable-Assigned Functions:**
```javascript
const handler = function() { };
const process = () => { };
// Labels: "handler", "process"
```

**Single Callback:**
```javascript
setTimeout(function() {
    console.log("Hello");
}, 1000);
// Label: "clb(setTimeout)"
```

**Multiple Callbacks:**
```javascript
processData(
    function() { console.log("First"); },
    () => { console.log("Second"); }
);
// Labels: "clb(processData)[1]", "clb(processData)[2]"
```

**Method Callbacks:**
```javascript
[1, 2, 3].forEach(x => console.log(x));
// Label: "clb(unknown.forEach)"

obj.method.chain(function() { });
// Label: "clb(obj.method.chain)"
```

**Nested Anonymous Functions (Non-Callbacks):**
```javascript
function outer() {
    const inner = () => { };  // Label: "inner"
    (() => { })();            // IIFE - Label: "outer:anon[1]"
}
```

## Testing

### Test Structure

- `tests/input/`: Test input files organized by feature
  - `basics/`: Basic language features (arrow functions, assignments, etc.)
  - `callbacks/`: Callback function naming tests
  - `classes/`: Class-related tests
  - `es6/`: ES6+ features (destructuring, patterns, etc.)
  - `import-export/`: Module system tests (ES6, CommonJS, AMD)
  - `JSX/`: JSX tests
  - `typescript/`: TypeScript tests
  - `vue/`: Vue.js tests
  - `limits/`: Edge cases and limitations
  - `unhandled/`: Known unhandled cases
  
- `tests/reference/`: Expected outputs for each strategy
  - `DEMAND/`: Expected results for DEMAND strategy
  - `ONESHOT/`: Expected results for ONESHOT strategy

- `tests/ground_truths/`: Ground truth data for validation

### Running Tests

```bash
npm test  # Runs Jest tests + Python validation
```

Tests validate that the call graph output matches expected results for various input scenarios and strategies.

## Extension Points

### Adding New Vertex Types

1. Define new vertex class in `flowgraph.js`
2. Add vertex creation logic
3. Update `addIntraproceduralFlowGraphEdges()` to create edges
4. Update `callgraph.js` if needed for extraction
5. Add tests in `tests/input/`

### Adding New Native Functions

1. Edit `harness.js` to add function signature
2. Edit `natives.js` to add flow edges
3. Add entry to `nativeFlows` object or implement special handling
4. Define flow edges for the native function
5. Test with relevant callback patterns

### Supporting New Language Features

1. Update parser in `astutil.js` if needed
2. Add AST node handling in `bindings.js` for scoping
3. Add flow rules in `flowgraph.js` for the new node types
4. Update `addIntraproceduralFlowGraphEdges()` to handle new expressions/statements
5. Add tests in `tests/input/`
6. Add reference outputs in `tests/reference/`

### Custom Analysis Strategies

1. Create new module similar to `pessimistic.js` or `semioptimistic.js`
2. Implement `buildCallGraph()` function
3. Follow the pattern:
   - Create `FlowGraph`
   - Add native flow edges
   - Add intraprocedural flow edges
   - Add custom interprocedural logic
   - Extract call graph
4. Update `runner.js` to recognize new strategy
5. Add strategy to command-line options
6. Create reference outputs for the new strategy

## Dependencies

### Runtime
- `@babel/core`, `@babel/preset-flow`: Babel parsing infrastructure
- `@typescript-eslint/typescript-estree`: TypeScript/JavaScript AST parser (primary parser)
- `typescript`: TypeScript compiler
- `argparse`: Command-line argument parsing
- `underscore`: Utility functions

### Development
- `jest`: Testing framework

## File Organization

```
js-callgraph/
├── src/                      # Source code
│   ├── runner.js            # Main orchestrator
│   ├── astutil.js           # AST utilities
│   ├── bindings.js          # Name binding
│   ├── symtab.js            # Symbol tables
│   ├── flowgraph.js         # Flow graph construction
│   ├── callgraph.js         # Call graph extraction
│   ├── pessimistic.js       # Pessimistic strategy (NONE, ONESHOT)
│   ├── semioptimistic.js    # Optimistic strategy (DEMAND)
│   ├── graph.js             # Graph data structures
│   ├── natives.js           # Native function modeling
│   ├── harness.js           # Native function definitions
│   ├── module.js            # Module handling
│   ├── dftc.js              # Transitive closure
│   ├── utils.js             # Utilities
│   ├── diagnostics.js       # Diagnostics
│   ├── requireJsGraph.js    # RequireJS support
│   ├── callbackCounter.js   # Callback counting
│   ├── srcPreprocessor.js   # Source preprocessing
│   ├── set.js               # Set data structure
│   └── linkedList.js        # Linked list
├── tests/                   # Test suite
│   ├── input/              # Test inputs
│   │   ├── basics/
│   │   ├── classes/
│   │   ├── es6/
│   │   ├── import-export/
│   │   ├── JSX/
│   │   ├── typescript/
│   │   ├── vue/
│   │   ├── limits/
│   │   └── unhandled/
│   ├── reference/          # Expected outputs
│   │   ├── DEMAND/
│   │   └── ONESHOT/
│   └── ground_truths/      # Ground truth data
├── input-scripts/          # Example input scripts
├── js-callgraph.js         # CLI entry point
├── index.js                # Programmatic API
└── package.json            # Package metadata
```

## Key Algorithms

### Reachability Analysis (dftc.js)

Uses depth-first search to compute which vertices are reachable from each vertex in the flow graph. This is fundamental to call graph extraction.

**Algorithm**: Depth-First Transitive Closure
- Performs DFS from each vertex
- Computes all reachable vertices
- Used by both strategies to determine call relationships
- Simpler and faster than alternative algorithms

### One-Shot Closure Detection (pessimistic.js)

Identifies immediately invoked function expressions (IIFEs) and adds appropriate interprocedural flow edges for them.

**Pattern Detection**:
- Detects `(function() { ... })()`
- Detects `(function() { ... }).call/apply(...)`
- Adds direct flow edges from arguments to parameters
- Adds direct flow edges from returns to results

### Demand-Driven Propagation (semioptimistic.js)

Propagates flow information only along paths that may reach call sites, avoiding unnecessary work while maintaining precision.

**Algorithm**:
1. Build intraprocedural flow graph
2. Identify "interesting" flow (can reach call sites)
3. Iteratively add interprocedural edges for interesting flow
4. Use DFTC to compute reachability after each iteration
5. Repeat until no new edges are added (fixpoint)

**Benefits**:
- More precise than pessimistic strategies
- Avoids unnecessary propagation
- Still more expensive than ONESHOT

---

**Version**: 2.2.0  
**License**: Eclipse Public License v2.0  
**Repository**: https://github.com/gaborantal/js-callgraph
