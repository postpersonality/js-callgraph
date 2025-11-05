// Test Step() with inline function expressions

Step(
    function() {
        console.log("First step");
    },
    function() {
        console.log("Second step");
    },
    function() {
        console.log("Third step");
    }
);
