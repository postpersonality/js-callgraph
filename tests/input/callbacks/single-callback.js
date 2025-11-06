function someFn(a, b, callback) {
    callback();
}

someFn(1, 2, function() {
    console.log("callback");
});
