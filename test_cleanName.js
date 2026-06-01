const { cleanName } = require('./server_mock_cleanName');

function cleanNameMock(name) {
    if (!name) return "";
    let cleaned = name.toString()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "") // Strip trailing dots, symbols
        .replace(/\s+/g, " ")                        // Compress double spaces
        .trim();
    
    // Title Case
    return cleaned.toLowerCase().split(' ').map(word => {
        if (!word) return "";
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
}

console.log(cleanNameMock('saurabhd'));
console.log(cleanNameMock('saurabh d'));
