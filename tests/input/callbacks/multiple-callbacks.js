function someFn(cb1, cb2) {
    cb1();
    cb2();
}

someFn(
    function() { console.log("first"); },
    () => { console.log("second"); }
);
