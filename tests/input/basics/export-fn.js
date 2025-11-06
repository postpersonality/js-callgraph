exports.fn = function () {
    console.log("test");
};

exports.handler = function () {
    console.log("handler");
};

exports.arrowFn = () => {
    console.log("arrow");
};

exports.fn();
exports.handler();
exports.arrowFn();
