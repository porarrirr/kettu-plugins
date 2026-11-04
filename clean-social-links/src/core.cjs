// ES5 syntax intentionally: this also runs inside the iOS expression evaluator.
function cleanUrl(value, replaceX, settings) {
    if (typeof value !== "string") return value;
    // AliExpress queries can contain a search term or redirect destination.
    // Only direct product pages are safe for whole-query removal.
    var ali = /^https?:\/\/((?:[a-z0-9-]+\.)*aliexpress\.(?:com|us|ru))(?::\d+)?(\/[^?#]*)?(?=[?#]|$)/i.exec(value);
    var site;
    if (ali) {
        site = "cleanAliExpressLinks";
        if (/^(?:a|s\.click)\./i.test(ali[1]) || !/^\/item\/\d+\.html\/?$/i.test(ali[2] || "")) return value;
    }
    else {
        // Exact host check avoids touching lookalike domains or credentials.
        var match = /^https?:\/\/(?:[a-z0-9-]+\.)*(instagram\.com|x\.com|twitter\.com|amazon\.(?:com(?:\.(?:au|br|mx|be|tr))?|co\.(?:jp|uk|za)|de|fr|it|es|ca|in|nl|se|pl|ie|ae|sa|sg|eg|cn)|amzn\.(?:asia|to))(?=[:/?#]|$)(?::\d+)?(?:[/?#]|$)/i.exec(value);
        if (!match) return value;
        var domain = match[1].toLowerCase();
        site = domain === "instagram.com" ? "cleanInstagramLinks" : domain === "x.com" || domain === "twitter.com" ? "cleanXLinks" : "cleanAmazonLinks";
    }
    if (settings && settings[site] === false) return value;
    var query = value.indexOf("?");
    var fragment = value.indexOf("#");
    var cleaned = query < 0 || (fragment >= 0 && fragment < query) ? value : value.slice(0, query);
    if (replaceX === true) {
        cleaned = cleaned.replace(/^(https?:\/\/)(?:[a-z0-9-]+\.)*(?:x\.com|twitter\.com)(?=[:/?#]|$)/i, "$1fxtwitter.com");
    }
    return cleaned;
}
function cleanText(value, replaceX, settings) {
    if (typeof value !== "string") return value;
    return value.replace(/https?:\/\/[^\s<>"'`\u3000\u3001\u3002\uff01\uff1f\uff09\u300d\u300f]+/gi, function (token) {
        // Keep surrounding Markdown and sentence punctuation out of the URL.
        var suffix = "";
        while (/[)\]},.!;:]$/.test(token)) {
            suffix = token.slice(-1) + suffix;
            token = token.slice(0, -1);
        }
        return cleanUrl(token, replaceX, settings) + suffix;
    });
}
function copyField(object, key, transform) {
    if (!object || typeof object !== "object" || typeof object[key] !== "string") return object;
    var cleaned = transform(object[key]);
    if (cleaned === object[key]) return object;
    var descriptors = Object.getOwnPropertyDescriptors(object);
    var descriptor = descriptors[key];
    // Accessors cannot be combined with value/writable. Inherited properties
    // have no own descriptor, so materialize the cleaned value on the copy.
    descriptors[key] = {
        value: cleaned,
        enumerable: descriptor ? descriptor.enumerable : true,
        configurable: descriptor ? descriptor.configurable : true,
        writable: descriptor && "value" in descriptor ? descriptor.writable : true
    };
    // Preserve prototypes, nonenumerable properties, and attachments.
    return Object.create(Object.getPrototypeOf(object), descriptors);
}
module.exports = { cleanUrl: cleanUrl, cleanText: cleanText, copyField: copyField };
