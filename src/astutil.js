/*******************************************************************************
 * Copyright (c) 2013 Max Schaefer
 * Copyright (c) 2018 Persper Foundation
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *******************************************************************************/

const tsEstree = require('@typescript-eslint/typescript-estree');
const fs = require('fs');
// const vueParser = require('vue-parser');
const prep = require('./srcPreprocessor');
// import vueParser from 'vue-parser'
// const {vueParser} = require('vue-parser');

/* AST visitor */
function visit(root, visitor) {
    function doVisit(nd, parent, childProp) {
        if (!nd || typeof nd !== 'object')
            return;

        if (nd.type) {
            const res = visitor(nd, doVisit, parent, childProp);
            if (res === false)
                return;
        }

        for (const p in nd) {
            // skip over magic properties
            if (!nd.hasOwnProperty(p) || p.match(/^(range|loc|attr|comments|raw)$/))
                continue;
            doVisit(nd[p], nd, p);
        }
    }

    doVisit(root);
}

/* AST visitor with state */
function visitWithState(root, visitor) {
    const state = {
        'withinDeclarator': false,
        'withinParams': false
    };

    function doVisit(nd, parent, childProp) {
        if (!nd || typeof nd !== 'object')
            return;

        if (nd.type) {
            const res = visitor(nd, doVisit, state, parent, childProp);
            if (res === false)
                return;
        }

        for (const p in nd) {
            // skip over magic properties
            if (!nd.hasOwnProperty(p) || p.match(/^(range|loc|attr|comments|raw)$/))
                continue;
            doVisit(nd[p], nd, p);
        }
    }

    doVisit(root);
}

/* Set up `attr` field that can be used to attach attributes to
 * nodes, and fill in `enclosingFunction` and `enclosingFile`
 * attributes. */
function init(root) {
    let enclosingFunction = null;
    let enclosingFile = null;
    // global collections containing all functions and all call sites
    root.attr.functions = [];
    root.attr.calls = [];
    
    // Map for tracking anonymous function counters
    // Key: enclosingFunction (or 'global'), Value: counter
    const anonCounters = new Map();
    
    // Map to track actual AST parent for array elements
    // When visitor traverses arrays, elements get the array as parent
    // We need to track the AST node that owns the array
    const arrayParents = new Map();
    
    function getNextAnonIndex(encFunc) {
        const key = encFunc || 'global';
        const current = anonCounters.get(key) || 0;
        const next = current + 1;
        anonCounters.set(key, next);
        return next;
    }
    
    visit(root, function (nd, doVisit, parent, childProp) {
        // Track array parents for proper callback detection
        // This needs to happen BEFORE we process children, so when
        // children are visited, they can look up their array's owner
        for (let p in nd) {
            if (!nd.hasOwnProperty(p))
                continue;
            if (Array.isArray(nd[p])) {
                arrayParents.set(nd[p], nd);
            }
        }
        if (nd.type && !nd.attr)
            nd.attr = {};

        if (enclosingFunction) {
            nd.attr.enclosingFunction = enclosingFunction;
        }
        if (enclosingFile) {
            nd.attr.enclosingFile = enclosingFile;
        }
        if (nd.type === 'Program') {
            enclosingFile = nd.attr.filename;
        }

        /* Method Definition (Case 1)

        This case is covered by test case: tests/basics/method-def.truth

        Example:

            var obj = {
                methodName: function () {
                    return 42;
                }
            }

        Esprima AST:

            interface Property {
                type: 'Property';
                key: Expression;
                computed: boolean;
                value: Expression | null;
                kind: 'get' | 'set' | 'init';
                method: false;
                shorthand: boolean;
            }
        */
        if (nd.type === 'FunctionExpression' && parent && parent.type === 'Property') {
            if (!parent.computed) {
                if (parent.key.type === 'Identifier') {
                    nd.id = parent.key;
                } else if (parent.key.type === 'Literal') {
                    // create a new `Identifier` AST node and set it to `FunctionExpression`'s id
                    nd.id = {
                        type: 'Identifier',
                        name: parent.key.value,
                        range: parent.key.range,
                        loc: parent.key.loc
                    };
                } else {
                    console.log("WARNING: unexpected key type of 'Property'.");
                }
            } else
                console.log("WARNING: Computed property for method definition, not yet supported.");
        }

        if (nd.type === 'FunctionDeclaration' ||
            nd.type === 'FunctionExpression' ||
            nd.type === 'ArrowFunctionExpression') {

            root.attr.functions.push(nd);
            nd.attr.parent = parent;
            nd.attr.childProp = childProp;
            
            // Check if function will be anonymous after all naming attempts
            // This mirrors the logic in funcname()
            let willBeAnonymous = false;
            if (nd.id === null) {
                // Check if parent provides a name
                let hasParentName = false;
                if (parent?.type === 'AssignmentExpression') {
                    if (parent?.left?.type == 'Identifier') {
                        hasParentName = true;
                    } else if (parent?.left?.type === 'MemberExpression') {
                        // exports.fn = function() {} should have a name
                        if (!parent.left.computed && parent.left.property?.type === 'Identifier') {
                            hasParentName = true;
                        }
                    }
                } else if (parent?.type == 'VariableDeclarator') {
                    if (parent?.id?.type == 'Identifier') {
                        hasParentName = true;
                    }
                }
                willBeAnonymous = !hasParentName;
            }
            
            // If function is anonymous, determine if it's a callback or regular anonymous
            if (willBeAnonymous) {
                // Get the real parent if parent is an array
                const realParent = Array.isArray(parent) ? arrayParents.get(parent) : parent;
                
                // Check if function is a callback (passed as argument to a call)
                // When parent is an array, childProp is the numeric index
                // We need to check if realParent is a CallExpression and has 'arguments' property
                const isCallback = (realParent?.type === 'CallExpression' || realParent?.type === 'NewExpression') 
                                  && Array.isArray(parent) && realParent.arguments === parent;
                
                if (isCallback) {
                    // Save callback context information
                    nd.attr.isCallback = true;
                    nd.attr.callbackCallNode = realParent;  // save reference to CallExpression
                    
                    // Find index of this function among arguments
                    const argumentIndex = parent.indexOf(nd);
                    nd.attr.callbackArgumentIndex = argumentIndex;
                    
                    // Count how many functions are passed in this call (for numbering)
                    const functionArgsCount = parent.filter(arg => 
                        arg.type === 'FunctionExpression' || 
                        arg.type === 'ArrowFunctionExpression'
                    ).length;
                    nd.attr.callbackFunctionArgsCount = functionArgsCount;
                    
                    // Determine position among function arguments (not all arguments)
                    let functionArgPosition = 0;
                    for (let i = 0; i <= argumentIndex; i++) {
                        const arg = parent[i];
                        if (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression') {
                            functionArgPosition++;
                        }
                    }
                    nd.attr.callbackFunctionPosition = functionArgPosition;
                } else {
                    // Not a callback - use existing anonymous numbering
                    nd.attr.anonIndex = getNextAnonIndex(enclosingFunction);
                }
            }
            
            const old_enclosingFunction = enclosingFunction;
            enclosingFunction = nd;
            doVisit(nd.id);
            doVisit(nd.params);
            doVisit(nd.body);
            enclosingFunction = old_enclosingFunction;
            return false;
        }

        /* Method Definition (Case 2)
        Ref: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/Method_definitions

        Example:

            class Apple {
                color () {
                    return 'red';
                }
            }

        Esprima AST:

            interface MethodDefinition {
                type: 'MethodDefinition';
                key: Expression | null;
                computed: boolean;
                value: FunctionExpression | null;
                kind: 'method' | 'constructor';
                static: boolean;
            }
        */
        if (nd.type === 'MethodDefinition')
            if (!nd.computed) {
                if (nd.key.type === 'Identifier') {
                    nd.value.id = nd.key;
                } else if (nd.key.type === 'Literal') {
                    // this case is covered by test case: tests/unexpected/stringiterator.truth
                    console.log("WARNING: invalid syntax, method name is of type Literal instead of Identifier.");
                } else {
                    console.log("WARNING: unexpected key type of 'MethodDefinition'.");
                }
            } else {
                console.log("WARNING: Computed property for method definition, not yet supported.");
            }

        if (nd.type === 'CallExpression' || nd.type === 'NewExpression')
            root.attr.calls.push(nd);
    });
}

/* Simple version of UNIX basename. */
function basename(filename) {
    if (!filename) {
        return "<???>";
    }
    let idx = filename.lastIndexOf('/');
    if (idx === -1) {
        idx = filename.lastIndexOf('\\');
    }
    return filename.substring(idx + 1);
}

function isAnon(funcName) {
    return funcName === "anon";
}

/**
 * Builds name from a MemberExpression chain
 * @param {Object} node - MemberExpression node
 * @returns {string} - name like "obj.prop.method"
 */
function buildMemberExpressionName(node) {
    if (node.type === 'Identifier') {
        return node.name;
    }
    
    if (node.type === 'MemberExpression') {
        const objectName = buildMemberExpressionName(node.object);
        const propertyName = node.computed 
            ? '[computed]'  // for obj[expr]
            : node.property.name;
        return `${objectName}.${propertyName}`;
    }
    
    return 'unknown';
}

/**
 * Extracts the name of the called function from a CallExpression
 * @param {Object} callNode - CallExpression node
 * @returns {string|null} - function name or null if cannot determine
 */
function getCalleeName(callNode) {
    if (!callNode || callNode.type !== 'CallExpression') {
        return null;
    }
    
    const callee = callNode.callee;
    
    // Simple case: someFn(...)
    if (callee.type === 'Identifier') {
        return callee.name;
    }
    
    // Method call: obj.method(...)
    if (callee.type === 'MemberExpression') {
        // Build full name: obj.prop.method
        return buildMemberExpressionName(callee);
    }
    
    // Other cases (e.g., IIFE): cannot determine simple name
    return null;
}

// func must be function node in ast
function funcname(func) {
    if (func === undefined) {
        console.log('WARNING: func undefined in astutil/funcname.');
    } else if (func.id === null) {
        const parent = func?.attr?.parent;
        
        // Try to find name through parent nodes
        if (parent?.type === 'AssignmentExpression') {
            if (parent?.left?.type == 'Identifier') {
                return parent.left.name;
            } else if (parent?.left?.type === 'MemberExpression') {
                // exports.fn = function() {} -> "fn"
                // module.exports.fn = function() {} -> "fn"
                if (!parent.left.computed && parent.left.property?.type === 'Identifier') {
                    return parent.left.property.name;
                }
            }
        } else if (parent?.type == 'VariableDeclarator') {
            if (parent?.id?.type == 'Identifier') {
                return parent.id.name;
            }
        }
        
        // Handle callbacks with contextual naming
        if (func.attr && func.attr.isCallback) {
            const callNode = func.attr.callbackCallNode;
            const calleeName = getCalleeName(callNode);
            
            if (calleeName) {
                const functionArgsCount = func.attr.callbackFunctionArgsCount;
                const functionPosition = func.attr.callbackFunctionPosition;
                
                // If only one callback in the call
                if (functionArgsCount === 1) {
                    return `clb(${calleeName})`;
                } else {
                    // If multiple callbacks, add index
                    return `clb(${calleeName})[${functionPosition}]`;
                }
            }
            // If couldn't get callee name, fallback to regular numbering
        }
        
        // Existing logic for regular anonymous functions
        if (func.attr && typeof func.attr.anonIndex === 'number') {
            const encFunc = func.attr.enclosingFunction;
            const parentName = encFuncName(encFunc);
            return `${parentName}:anon[${func.attr.anonIndex}]`;
        }
        
        return "anon"; // fallback
    }
    return func.id.name;
}

// encFunc can be undefined
function encFuncName(encFunc) {
    if (encFunc === undefined)
        return "global";
    return funcname(encFunc);
}

/* Pretty-print position. */
function ppPos(nd) {
    return basename(nd.attr.enclosingFile) + "@" + nd.loc.start.line + ":" + nd.range[0] + "-" + nd.range[1];
}

/* Build as AST from a collection of source files */
function astFromFiles(files) {
    const ast = {
        type: 'ProgramCollection',
        programs: [],
        attr: {}
    }

    for (let file of files) {
        const src = fs.readFileSync(file, 'utf-8');
        ast.programs.push(buildProgram(file, src));
    }
    init(ast);
    return ast;
}

/* Build an AST from file name and source code
Args:
    fname - A string, the name of the source file
      src - A string, the source code

Return:
    If succeeded, return an ast node of type 'ProgramCollection'.
    If failed, return null.
*/
function astFromSrc(fname, src) {
    const prog = buildProgram(fname, src);
    if (prog === null) {
        return null;
    }
    const ast = {
        'type': 'ProgramCollection',
        'programs': [prog],
        'attr': {}
    }
    init(ast);
    return ast;
}

function reportError(msg, err) {
    console.log('-------------------------------------------');
    console.log(msg);
    console.log(err.stack);
    console.log('-------------------------------------------');
}

/* Returns an ast node of type 'Program'
To avoid confusion caused by too many different parsing settings,
please call this function whenever possible instead of rewriting esprima.parseModule...
*/
function parse(src,jsxCheck) {
    return tsEstree.parse(src, {
        loc: true,
        range: true,
        jsx: jsxCheck
    });
}

/* Parse a single source file and return its ast
Args:
    fname - A string, the name of the source file
      src - A string, the source code

Return:
    If succeeded, return an ast node of type 'Program'.
    If failed, return null.
*/
function buildProgram(fname, src) {
    let prog;

    // trim hashbang
    src = prep.trimHashbangPrep(src);
    // extract script from .vue file
    try {
        if (fname.endsWith('.vue')) {
            // src = vueParser.parse(src, 'module');
            console.log("Not yet supported");
        }
    } catch (err) {
        reportError('WARNING: Extracting <script> from .vue failed.', err);
        return null;
    }

    // parse javascript
    if (prog === undefined) {
        try {
            (fname.endsWith(".tsx") || fname.endsWith(".jsx"))? prog = parse(src,true) : prog = parse(src,false);

        } catch (err) {
            reportError('Warning: Parsing failed for' + fname, err);
            return null;
        }
    }
    prog.attr = {filename: fname};
    return prog;
}

// cf is used by getFunctions
function cf(funcObj) {
    return funcObj.file + ':' +
        funcObj.name + ':' +
        funcObj.range[0] + ':' +
        funcObj.range[1] + ':' +
        (funcObj.charRange[1] - funcObj.charRange[0]);
}

/* Return a list of objects storing function info in root

Args:
    root - An ast node of type 'ProgramCollection',
         - the output of astFromSrc function,
         - thus, root.programs.length is equal to 1
    src  - A string, the corresponding source code of `root`

Returns:
    A list of objects, each with the following properties
    {
        'name': a valid function name | 'anon' | 'global',
        'file': a valid file name,
        'range': a list of two integers,
        'code': code of the function | null (for global context),
        'encFuncName': a valid function name | 'anon' | 'global' | null (for global context),
        'cf': a string representing the colon format id
    }
*/
function getFunctions(root, src) {
    const funcs = [];
    const funcNodes = root.attr.functions;

    for (let i = 0; i < funcNodes.length; ++i) {
        const fn = funcNodes[i];
        const funcName = funcname(fn);
        const startLine = fn.loc.start['line'];
        const endLine = fn.loc.end['line'];

        // name, file and range are for colon format id
        // code and encFuncName are added for trackFunctions
        funcs.push({
            'name': funcName,
            'file': fn.attr.enclosingFile,
            'range': [startLine, endLine],
            'charRange': fn.range,
            'code': src.substring(fn.range[0], fn.range[1]),
            'encFuncName': encFuncName(fn.attr.enclosingFunction)
        });
    }

    // Add 'cf' property
    funcs.forEach(funcObj => {
        funcObj['cf'] = cf(funcObj);
    });

    // Create a fake function object for global context
    console.assert(root.programs.length === 1);
    const prog = root.programs[0];
    funcs.push({
        'name': 'global',
        'file': prog.attr.filename,
        'range': [prog.loc.start['line'], prog.loc.end['line']],
        'charRange': null,
        'code': null,
        'encFuncName': null,
        'cf': prog.attr.filename + ':global'
    });

    return funcs;
}

/* Check if nd is an assignment to module.exports

Args:
    nd - an ast node

Returns:
    true if nd represents an assignment to module.exports, false otherwise

Relevant docs:

    interface MemberExpression {
        type: 'MemberExpression';
        computed: boolean;
        object: Expression;
        property: Expression;
    }
*/
function isModuleExports(nd) {
    if (nd.type !== 'AssignmentExpression') {
        return false;
    }

    const left = nd.left;

    if (left.type !== 'MemberExpression') {
        return false;
    }

    const object = left.object;
    const property = left.property;

    if (object.type !== 'Identifier' || property.type !== 'Identifier') {
        return false;
    }

    return object.name === 'module' && property.name === 'exports';
}

/*
Args:
       nd - an ast node
  fn_name - a function name to compare to

Returns: true if nd represents a call to fn_name, false otherwise

Relevant docs:

    interface CallExpression {
        type: 'CallExpression';
        callee: Expression;
        arguments: ArgumentListElement[];
    }
*/
function isCallTo(nd, fn_name) {
    if (nd.type !== 'CallExpression') {
        return false;
    }

    const callee = nd.callee;

    if (callee.type !== 'Identifier') {
        return false;
    }

    return callee.name === fn_name;
}

/*
Args:
       fn - an ast node representing a FunctionDeclaration

Returns:
    A list containing all of the ReturnStatement nodes' values in fn's body

Relevant docs:

    interface FunctionDeclaration {
        type: 'FunctionDeclaration';
        id: Identifier | null;
        params: FunctionParameter[];
        body: BlockStatement;
        generator: boolean;
        async: boolean;
        expression: false;
    }

    interface BlockStatement {
        type: 'BlockStatement';
        body: StatementListItem[];
    }

    interface ReturnStatement {
        type: 'ReturnStatement';
        argument: Expression | null;
    }
*/
function getReturnValues(fn) {
    const lst = [];
    const fnBody = fn.body;
    /* There're two cases here:
    Case 1. fn_body is of type 'BlockStatement'
        this is the most common case, for example
        const f = () => {return 1;};
    Case 2. fn_body is not of type 'BlockStatement'
        this case is covered by test case:
            tests/import-export/define/arrow-func-no-block-statement-require.truth
        const f = () => 1;

        Esprima output:
        {
            "type": "Program",
            "body": [
                {
                    "type": "VariableDeclaration",
                    "declarations": [
                        {
                            "type": "VariableDeclarator",
                            "id": {
                                "type": "Identifier",
                                "name": "f"
                            },
                            "init": {
                                "type": "ArrowFunctionExpression",
                                "id": null,
                                "params": [],
                                "body": {
                                    "type": "Literal",
                                    "value": 1,
                                    "raw": "1"
                                },
                                "generator": false,
                                "expression": true,
                                "async": false
                            }
                        }
                    ],
                    "kind": "const"
                }
            ],
            "sourceType": "script"
        }
    */
    if (fnBody.type === 'BlockStatement') {
        const block = fnBody.body;
        for (let i = 0; i < block.length; i++) {
            if (block[i].type === 'ReturnStatement') {
                lst.push(block[i].argument);
            }
        }
    } else {
        lst.push(fnBody);
    }
    return lst;
}

/*
Args:
    nd - An ast node

Returns:
    A boolean, true if nd is a function declaration
    or function expression or arrow function expression,
    false otherwise.
*/
function isFunction(nd) {
    return nd.type === 'FunctionDeclaration' ||
        nd.type === 'FunctionExpression' ||
        nd.type === 'ArrowFunctionExpression'
}

module.exports.visit = visit;
module.exports.visitWithState = visitWithState;
module.exports.init = init;
module.exports.ppPos = ppPos;
module.exports.funcname = funcname;
module.exports.encFuncName = encFuncName;
module.exports.astFromFiles = astFromFiles;
module.exports.astFromSrc = astFromSrc;
module.exports.parse = parse;
module.exports.getFunctions = getFunctions;
module.exports.isAnon = isAnon;
module.exports.isModuleExports = isModuleExports;
module.exports.isCallTo = isCallTo;
module.exports.getReturnValues = getReturnValues;
module.exports.isFunction = isFunction;
module.exports.cf = cf;
module.exports.getCalleeName = getCalleeName;
module.exports.buildMemberExpressionName = buildMemberExpressionName;
