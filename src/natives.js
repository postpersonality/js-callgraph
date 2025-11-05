/*******************************************************************************
 * Copyright (c) 2013 Max Schaefer
 * Copyright (c) 2018 Persper Foundation
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *******************************************************************************/

/* Module for adding standard library/DOM modelling to flow graph. */


const flowgraph = require('./flowgraph');
const astutil = require('./astutil');
const nativeFlows = require('./harness').nativeFlows;

function addNativeFlowEdges(flow_graph) {
    for (const native in nativeFlows) {
        if (!nativeFlows.hasOwnProperty(native)) {
            continue;
        }
        const target = nativeFlows[native];
        flow_graph.addEdge(
            flowgraph.nativeVertex(native),
            flowgraph.propVertex({
                type: 'Identifier',
                name: target
            })
        );
    }
    return flow_graph;
}

/**
 * Check if a call expression is a Step() call
 */
function isStepCall(call) {
    return call.type === 'CallExpression' && 
           call.callee.type === 'Identifier' && 
           call.callee.name === 'Step';
}

/**
 * Handle Step() call and add flow edges for sequential execution
 */
function handleStepCall(call, flow_graph, ast) {
    // Get all function arguments
    const steps = call.arguments.filter(arg => 
        arg.type === 'FunctionExpression' || 
        arg.type === 'ArrowFunctionExpression' ||
        arg.type === 'Identifier'  // reference to a function
    );
    
    if (steps.length === 0) return;
    
    // Helper function to resolve an identifier to its function declaration
    function resolveFunctionNode(step) {
        if (step.type === 'Identifier' && step.attr && step.attr.scope) {
            const declId = step.attr.scope.get(step.name);
            if (declId && declId.name === step.name) {
                // declId is the identifier from the function/variable declaration
                // Search ast.attr.functions for the function with this id
                if (ast.attr && ast.attr.functions) {
                    for (let i = 0; i < ast.attr.functions.length; i++) {
                        const func = ast.attr.functions[i];
                        // Check if this is a FunctionDeclaration with matching id
                        if (func.id === declId) {
                            return func;
                        }
                        // Check if this is a FunctionExpression/ArrowFunction whose parent variable has this id
                        // For: const foo = () => {}
                        // The function is the ArrowFunctionExpression, not the VariableDeclarator
                        // But the function is in ast.attr.functions
                        // We need to check if this function's "name" (from its context) matches
                        if (!func.id && func.attr && func.attr.enclosingFunction === undefined) {
                            // This is a top-level anonymous function (likely arrow or function expression)
                            // Check if it's assigned to the variable we're looking for
                            // We can check by looking at the function's name as computed by funcname
                            const fname = astutil.funcname(func);
                            if (fname === step.name) {
                                return func;
                            }
                        }
                    }
                }
            }
        }
        return step;
    }
    
    // First step is called from the Step() call site
    // Create edge from first function to the original Step() call
    const firstStep = steps[0];
    const firstStepVertex = (firstStep.type === 'Identifier') 
        ? flowgraph.vertexFor(firstStep)
        : flowgraph.funcVertex(firstStep);
    
    flow_graph.addEdge(firstStepVertex, flowgraph.calleeVertex(call));
    
    // Sequentially link each step to the next
    // The pattern: step1 → step2 means "when step1 finishes, step2 is called"
    for (let i = 0; i < steps.length - 1; i++) {
        const currentStep = steps[i];
        const nextStep = steps[i + 1];
        
        // Resolve identifiers to their function declarations
        const currentStepFunc = resolveFunctionNode(currentStep);
        
        // Create a pseudo-call expression to represent the implicit call
        // from currentStep to nextStep
        // Use currentStep's location so the call appears to come from currentStep
        const currentStepLoc = currentStep.loc || { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
        const currentStepRange = currentStep.range || [0, 0];
        
        const pseudoCall = {
            type: 'CallExpression',
            callee: nextStep,
            arguments: [],
            loc: currentStepLoc,
            range: currentStepRange,
            attr: {
                synthetic: true,  // Mark as synthetic for debugging
                enclosingFunction: currentStepFunc,
                enclosingFile: call.attr.enclosingFile
            }
        };
        
        // Get vertex for the next step's function
        const nextStepVertex = (nextStep.type === 'Identifier')
            ? flowgraph.vertexFor(nextStep)
            : flowgraph.funcVertex(nextStep);
        
        // Get vertex for the current step's function
        const currentStepFuncVertex = (currentStep.type === 'Identifier')
            ? flowgraph.vertexFor(currentStep)
            : flowgraph.funcVertex(currentStep);
        
        // Create the call relationship:
        // The call graph extraction works by finding FuncVertex nodes that reach CalleeVertex nodes
        // For step1 → step2, we need:
        //   1. step2's FuncVertex can reach a CalleeVertex (the pseudo-call)
        //   2. step1's return vertex can reach that CalleeVertex
        //   3. The CalleeVertex has enclosingFunction = step1's function node
        
        // Get the resolved function node for currentStep (for retVertex)
        const currentStepFuncNode = resolveFunctionNode(currentStep);
        
        // Add edge: nextStep function → pseudo-call's callee position
        // This makes nextStep callable from this pseudo-call
        flow_graph.addEdge(nextStepVertex, flowgraph.calleeVertex(pseudoCall));
        
        // Add edge: currentStep's return vertex → pseudo-call's callee position
        // This makes the pseudo-call reachable when currentStep completes/returns
        // This ensures the pseudo-call is reachable from currentStep without making
        // currentStep itself a target of the call
        flow_graph.addEdge(flowgraph.retVertex(currentStepFuncNode), flowgraph.calleeVertex(pseudoCall));
    }
}

/**
 * Add flow edges for Step() calls in the AST
 */
function addStepFlowEdges(ast, flow_graph) {
    // Find all Step() calls
    astutil.visit(ast, function(nd) {
        if (isStepCall(nd)) {
            handleStepCall(nd, flow_graph, ast);
        }
    });
    return flow_graph;
}

exports.addNativeFlowEdges = addNativeFlowEdges;
exports.addStepFlowEdges = addStepFlowEdges;

