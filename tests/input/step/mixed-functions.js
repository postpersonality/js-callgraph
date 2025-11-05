// Test Step() with mixed function types

function namedFunc() {
    console.log("Named function");
}

const arrowFunc = () => { console.log("Arrow function"); };

Step(
    namedFunc,
    arrowFunc,
    function() { console.log("Anonymous function"); }
);
