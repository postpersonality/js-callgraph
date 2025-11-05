// Basic Step() test: three sequential functions
function step1() {
    console.log("Step 1");
}

function step2() {
    console.log("Step 2");
}

function step3() {
    console.log("Step 3");
}

// Call Step with three functions - they should execute sequentially
Step(step1, step2, step3);
