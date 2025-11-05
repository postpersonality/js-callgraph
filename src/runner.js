/*******************************************************************************
 * Copyright (c) 2013 Max Schaefer
 * Copyright (c) 2018 Persper Foundation
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *******************************************************************************/

const bindings = require('./bindings');
const astutil = require('./astutil');
const pessimistic = require('./pessimistic');
const semioptimistic = require('./semioptimistic');
const callbackCounter = require('./callbackCounter');
const requireJsGraph = require('./requireJsGraph');
const path = require('path');
const fs = require('fs');
const utils = require('./utils');


this.args = null;
this.files = null;
this.consoleOutput = null;

Array.prototype.remove = function () {
    let what;
    let a = arguments;
    let L = a.length;
    let ax;
    while (L && this.length) {
        what = a[--L];
        while ((ax = this.indexOf(what)) !== -1) {
            this.splice(ax, 1);
        }
    }
    return this;
};

let addNode = function (edge, v) {
    if (v.type === 'CalleeVertex') {
        const nd = v.call;
        edge.label = astutil.encFuncName(nd.attr.enclosingFunction);
        edge.file = nd.attr.enclosingFile;
        edge.start = {row: nd.loc.start.line, column: nd.loc.start.column};
        edge.end = {row: nd.loc.end.line, column: nd.loc.end.column};
        edge.range = {start: nd.range[0], end: nd.range[1]};
        return edge;
    }
    if (v.type === 'FuncVertex') {
        edge.label = astutil.funcname(v.func);
        edge.file = v.func.attr.enclosingFile;
        edge.start = {row: v.func.loc.start.line, column: v.func.loc.start.column};
        edge.end = {row: v.func.loc.end.line, column: v.func.loc.end.column};
        edge.range = {start: v.func.range[0], end: v.func.range[1]};
        return edge;
    }
    if (v.type === 'NativeVertex') {
        //'Math_log' (Native)
        edge.label = v.name;
        edge.file = "Native";
        edge.start.row = null;
        edge.end.row = null;
        edge.start.column = null;
        edge.end.column = null;
        edge.range = {start: null, end: null};
        return edge;
    }
    throw new Error("strange vertex: " + v);
};

let buildBinding = function (call, fn) {
    const edge = {
        source: {
            label: null,
            file: null,
            start: {row: null, column: null},
            end: {row: null, column: null},
            range: {start: null, end: null}
        },
        target: {
            label: null,
            file: null,
            start: {row: null, column: null},
            end: {row: null, column: null},
            range: {start: null, end: null}
        }
    };
    addNode(edge.source, call);
    addNode(edge.target, fn);
    return edge;
};

function pp(v) {
    if (v.type === 'CalleeVertex') {
        return '\'' + astutil.encFuncName(v.call.attr.enclosingFunction) + '\' (' + astutil.ppPos(v.call) + ')';
    }
    if (v.type === 'FuncVertex') {
        return '\'' + astutil.funcname(v.func) + '\' (' + astutil.ppPos(v.func) + ')';
    }
    if (v.type === 'NativeVertex') {
        return '\'' + v.name + '\' (Native)';
    }
    throw new Error("strange vertex: " + v);
}

function ppAcg(v) {
    if (v.type === 'CalleeVertex')
        return astutil.ppPos(v.call);
    if (v.type === 'FuncVertex')
        return astutil.ppPos(v.func);
    if (v.type === 'NativeVertex')
        return v.name;
    throw new Error("strange vertex: " + v);
}

let build = function () {
    const args = this.args;
    const consoleOutput = this.consoleOutput;
    const filter = this.filter;
    var edgesOfFunctionsCalled = [];

    let files = this.files;

    if (filter !== undefined && filter.length > 0) {
        const filteredfiles = [];
        files.forEach(function (file) {
            filteredfiles.push(file);
            filter.forEach(function (elem) {
                const trunk = elem.substr(1).trim();
                const expression = new RegExp(trunk, "gm");
                const result = expression.test(file);

                if (result && elem.startsWith('-')) {
                    filteredfiles.remove(file);
                }

                if (result && elem.startsWith('+')) {
                    filteredfiles.push(file);
                }

            });
        });
        files = Array.from(new Set(filteredfiles));
    }

    args.strategy = args.strategy || 'ONESHOT';

    if (!args.strategy.match(/^(NONE|ONESHOT|DEMAND|FULL)$/)) {
        console.warn("Unknown strategy: " + args.strategy);
        process.exit(-1);
    }
    if (args.strategy === 'FULL') {
        console.warn('strategy FULL not implemented yet; using DEMAND instead');
        args.strategy = 'DEMAND';
    }
    if (args.time) console.time("parsing  ");
    const ast = astutil.astFromFiles(files);
    if (args.time) console.timeEnd("parsing  ");

    if (args.time) console.time("bindings ");
    bindings.addBindings(ast);
    if (args.time) console.timeEnd("bindings ");

    if (args.time) console.time("callgraph");
    let cg;
    if (args.strategy === 'NONE' || args.strategy === 'ONESHOT') {
        cg = pessimistic.buildCallGraph(ast, args.strategy === 'NONE');
        edgesOfFunctionsCalled = retrieveAllCalledFunctionsACG(cg);
    } else if (args.strategy === 'DEMAND') {
        cg = semioptimistic.buildCallGraph(ast);
        if (args.analyzertype === "nativecalls" ) {
            edgesOfFunctionsCalled = retrieveAllCalledFunctionsNative(cg);
        } else if (args.analyzertype === "static") {
            edgesOfFunctionsCalled = retrieveAllCalledFunctionsStatic(cg);
        }
    }
    
    // Only write to file if output is specified and we have edges to write
    if (this.args.output && this.args.output[0] && edgesOfFunctionsCalled) {
        var outputFilename = this.args.output[0];
        var matchRegex = outputFilename.match(/^(.*\/)([^\/]+\.json)$/); // Extract the output directory from the filename pased from Lacuna
        if (matchRegex) {
            var outputDirectory = matchRegex[1];
            fs.writeFileSync(`${outputDirectory}edges-${args.analyzertype}.json`, JSON.stringify(edgesOfFunctionsCalled, null, 2));
        } else {
            console.error('File write error while extracting CG edges');
        }
    }
    if (args.time) console.timeEnd("callgraph");

    if (args.fg) {
        const serializedGraph = cg.fg.graph.serialize();
        serializedGraph.links.forEach((link) => {
            console.log(link.source, "=>", link.target);
        });
    }

    if (args.countCB)
        callbackCounter.countCallbacks(ast);

    if (args.reqJs)
        requireJsGraph.makeRequireJsGraph(ast).forEach(function (edge) {
            console.log(edge.toString());
        });
    if (args.cg) {
        const result = [];
        cg.edges.iter(function (call, fn) {
            result.push(buildBinding(call, fn));
            if (consoleOutput) {
                console.log(pp(call) + " -> " + pp(fn));
            }
        });
        if (this.args.output !== undefined) {
            let filename = this.args.output[0];
            if (!filename.endsWith(".json")) {
                filename += ".json";
            }

            let json_out = "";

            fs.writeFileSync(filename, "[", {flag: 'w+'}); /* Write initial JSON header and create file */

            for (let indx = 0; indx < result.length - 1; indx++) {
                const current = JSON.stringify(result[indx], null, 2) + ",";

                /* Most recent string length limit = 2^29 - 16
                    https://github.com/v8/v8/commit/ea56bf5513d0cbd2a35a9035c5c2996272b8b728 */
                if (json_out.length >= 2 ** 29 - 16 - current.length) {
                    fs.writeFileSync(filename, json_out, {flag: 'a'});
                    json_out = "";
                }

                json_out += current;
            }

            fs.writeFileSync(filename, json_out, {flag: 'a'});

            json_out = JSON.stringify(result[result.length - 1], null, 2) + "]";
            fs.writeFileSync(filename, json_out, {flag: 'a'}); /* Write final JSON bytes */
            console.log(`Call graph written to ${filename}`)
        }
        return result;
    }
};

/**
 * Retrieves all called functions for the static analyer
 * 
 * 
 * Returns:
 *  edges [{
 *  caller: {file: <String>, start: { line: groups.line, column: groups.column }}
 *  callee: {file: <String>, start: { line: groups.line, column: groups.column }}
 * }]
 */
let retrieveAllCalledFunctionsStatic = function(cg) {
    let calledFunctions = [];

	// Retrieve all callee functions
	cg.edges.iter(function(caller, callee)
	{
		if(callee.type == 'NativeVertex')
		{
			// We don't care about calls to native functions (e.g. Math.floor or Array.prototype.map).
			return;
		};

		// Determine callee.
		let file = callee.func.attr.enclosingFile;
		let start = callee.func.range[0];
		let end = callee.func.range[1];

		// Determine caller.
		let caller_start, caller_end,
		    caller_file = caller.call.attr.enclosingFile;

		let enclosing_function = caller.call.callee.attr.enclosingFunction;

		if(enclosing_function)
		{
			caller_start = enclosing_function.range[0];
			caller_end = enclosing_function.range[1];
		}else{
			// In case it's called from the global scope.
			caller_start = caller_end = null;
		}

		function equals(a)
		{
			return a.caller.file == caller_file && a.caller.range[0] == caller_start && a.caller.range[1] == caller_end &&
			       a.callee.file == file && a.callee.range[0] == start && a.callee.range[1] == end;
		}

		// If it's not yet in there, put it in. (prevent duplicates)
		if( ! calledFunctions.some(equals) )
		{
            let caller = { file: caller_file, range: [caller_start, caller_end] };
			let callee = { file: file, range: [start, end] };

			// caller = fix_entry(caller, scripts, html_file);
			// callee = fix_entry(callee, scripts, html_file);

			calledFunctions.push(
			{
				caller: caller,
				callee: callee
			});
		}
	});
	return calledFunctions;
};

/**
 * Retrieves all called functions for the native analyer
 * 
 * 
 * Returns:
 *  edges [{
 *  caller: {file: <String>, start: { line: groups.line, column: groups.column }}
 *  callee: {file: <String>, start: { line: groups.line, column: groups.column }}
 * }]
 */
let retrieveAllCalledFunctionsNative = function(cg) {
    let functions_called = [];

	// Add an caller->called entry to functions_called[]
	function add_entry(caller, callee)
	{
		function equals(a)
		{
			return a.caller.file == caller.file && a.caller.range[0] == caller.range[0] && a.caller.range[1] == caller.range[1] &&
			       a.callee.file == callee.file && a.callee.range[0] == callee.range[0] && a.callee.range[1] == callee.range[1];
		}

		// If it's not yet in there, put it in.
		if( ! functions_called.some(equals) )
		{

			functions_called.push(
			{
				caller: caller,
				callee: callee
			});
		}
	}

	// Retrieve all called functions
	cg.edges.iter(function(caller, callee)
	{
		// All we care about are native calls (that is, the 'called' node has type NativeVertex and is a function that accepts a function as one of its arguments).
		// All posibilities are listed in javascript-call-graph/harness.js.
		// Instead of using a huge switch() case, just loop over all arguments, and if any of them is a FunctionExpression, 

		if( callee.type == 'NativeVertex')
		{
			// console.log('native');
			// console.log(called);
			let args = caller.call.arguments;

			for(let i = 0; i < args.length; i++)
			{
				if( args[i].type == 'FunctionExpression' )
				{
					handle_function_argument(caller, caller.call.arguments[i]);
				}
			}
		}
	});

    function handle_function_argument(caller_node, func)
	{
		let caller = {file: null, range: [null, null]},
			called = {file: null, range: [null, null]};

		called.range = func.range;
		called.file = func.attr.enclosingFile;

		let enclosing_function = caller_node.call.attr.enclosingFunction;

		if(enclosing_function)
		{
			caller.file = enclosing_function.attr.enclosingFile;
			caller.range = enclosing_function.range;
		}else{
			caller.file = caller_node.call.attr.enclosingFile;
			// start and end are defaulted to null.
		}

		add_entry(caller, called);
	}

    return functions_called;
}

/**
 * Retrieves all called functions for the ACG analyer
 * 
 * 
 * Returns:
 *  edges [{
 *  caller: {file: <String>, start: { line: groups.line, column: groups.column }}
 *  callee: {file: <String>, start: { line: groups.line, column: groups.column }}
 * }]
 */
let retrieveAllCalledFunctionsACG = function(cg) {
    let edges = [];
    cg.edges.iter(function (call, fn) {
        edges.push(ppAcg(call) + " -> " + ppAcg(fn));
    });

    return edges;
}

exports.setFiles = function (inputList) {
    let filelist = [];
    inputList.forEach(function (file) {
        file = path.resolve(file);
        if (!fs.existsSync(file)) {
            console.warn('The path "' + file + '" does not exists.');
        } else if (fs.statSync(file).isDirectory()) {
            filelist = utils.collectFiles(file, filelist);
        } else if (file.endsWith(".js") || file.endsWith(".jsx") || file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".vue")) {
            filelist.push(file);
        }
    });
    this.files = Array.from(new Set(filelist));
    if (this.files.length === 0) {
        console.warn("Input file list is empty!");
        process.exit(-1);
    }
};

exports.setFilter = function (filter) {
    this.filter = filter;
};

exports.setArgs = function (args) {
    this.args = args;
};

exports.setConsoleOutput = function (value) {
    this.consoleOutput = value;
};

exports.build = build;
