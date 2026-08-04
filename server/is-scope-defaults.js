// Default section → IS filing for IS Scope.
//
// The lab already knows which standards sit in which section; without this every
// section starts empty and a TP sees the whole 270-standard catalogue. These are
// DEFAULTS only: whatever the admin saves in IS Scope Control → "1 · File standards"
// is stored in system_preferences and always wins over this file.
//
// Matching is punctuation-insensitive because the same standard is written a dozen
// ways across the lab's sheets — "IS 2556 Part 2 (2004)", "IS 2556 : Part 2 (2004)"
// and "IS 2556:Part 2:2004" all have to land on the same vault row. A second,
// year-less key catches the case where the vault holds a different edition than the
// sheet (e.g. sheet says IS 1536 (2001), vault holds IS 1536 (2023)).

const RAW_FILING = `
Miscellaneous
IS 15354 : Part 1 (2018)
IS 1660 (2009)
IS 15644 (2006)
IS 7466 (1994)
IS 2653 (2004)
IS 12592 (2002)
IS 1626 : Part 3 (1994)
IS 1741 (2019)
IS 1783 : Part 1 (2014)
IS 1783 : Part 2 (2014)
IS 4964 (2013)
IS 7933 (2022)
IS 1659 (2004)
IS 12585 (1988)
IS 15392 (2003)
IS 2347 (2017)
IS 13422 (1992)
IS 4148 (1989)
IS 13997 (2014)
IS 4308 : 2019
IS 2556 : Part 2 (2004)
IS 2556 : Part 4 (2004)
IS 4947 (2006)
IS 2556 : Part 15 (2004)
IS 10325 (2000)
IS 3319 (1995)
IS 459 (1992)
IS 651 (2007)
IS 3575 (1993)
IS 2556 : Part 3 (2004)
IS 303 (2024)
IS 4990 (2011)
IS 710 (2024)
IS 2556 : Part 5 (1994)
IS 2556 : Part 6 (2004)
IS 2556 : Part 6 (2021)
IS 1341 (2018)
IS 204 : Part 2 (1992)
IS 15354 : Part 1 (2023)
IS 2556 : Part 2 (2024)
IS 2681 (1993)
IS 1328 (1996)
IS 903 (1993)

Stove
IS 2980 : 1999
IS 4246 (2025)

Steel
IS 513 : Part 2 (2016)
IS 4270 (2001)
IS 513 : Part 1 (2016)
IS 3601 (2006)
IS 2062 (2011)
IS 1786 (2008)
IS 4923 (2017)
IS 3196 : Part 1 (2013)
IS 1879 (2010)
IS 10577 (1982)
IS 1536 (2023)
IS 6006 (2014)
IS 3589 (2001)
IS 398 : Part 2 (1996)
IS 1239 : Part 1 (2004)
IS 6003 (2010)
IS 1161 (2014)
IS 9523 (2000)
IS 10748 (2004)
IS 6006 (2010)
IS 280 (2006)
IS 432 : Part 2 (1982)
IS 3748 (2022)
IS 1536 (2001)
IS 5872 (1990)
IS 210 (2009)
IS 8329 (2000)
IS 733 (1983)
IS 12591 (2018)
IS 739 (1992)
IS 7181 (1986)
IS 4948 (2020)
IS 5517 (1993)
IS 617 (2024)
IS 432 : Part 1 (1982)

Cement
IS 1489 (Part 1) (2015)
IS 269 (2015)
IS 455 (2015)
IS 8042 (2015)
IS 12330 (1988)
IS 8041 (1990)
IS 3466 (1988)
IS 650 (1991)
IS 2185 : Part 3 (1984)
IS 14862 (2013)
IS 1489 : Part 2 (2015)
IS 6452 (1989)
IS 8229 (1986)

UPVC
IS 12818 (2010)
IS 13592 (2013)
IS 12786 (1989)
IS 10124 : Part 1 (2009)
IS 14735 (1999)
IS 9537 : Part 3 (1983)
IS 4984 (2016)
IS 4985 (2021)
IS 11722 (1986)
`;

// "IS 2556 : Part 2 (2004)" → "is2556part22004"
function scopeKey(isNumber) {
    return String(isNumber || '')
        .replace(/(\d)\.0+(?![0-9])/g, '$1')   // Excel exports the year as "2020.0"
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

// Same, minus a trailing 4-digit year → "is2556part2". Lets a sheet edition match a
// vault row of a different year rather than silently leaving the standard unfiled.
function scopeKeyNoYear(isNumber) {
    return scopeKey(isNumber).replace(/(19|20)\d{2}$/, '');
}

function buildDefaults() {
    const sections = [];
    const exact = new Map();
    const loose = new Map();
    let current = null;

    for (const line of RAW_FILING.split('\n')) {
        const text = line.trim();
        if (!text) continue;
        if (!/^IS\s/i.test(text)) {
            current = text;
            if (!sections.includes(current)) sections.push(current);
            continue;
        }
        if (!current) continue;
        const k = scopeKey(text);
        if (k && !exact.has(k)) exact.set(k, current);
        const lk = scopeKeyNoYear(text);
        // Only keep an unambiguous year-less key — if two sections claim the same
        // base standard, the loose match would be a coin flip, so drop it entirely.
        if (lk) loose.set(lk, loose.has(lk) && loose.get(lk) !== current ? null : current);
    }
    return { sections, exact, loose };
}

const { sections: DEFAULT_SECTIONS, exact: EXACT_MAP, loose: LOOSE_MAP } = buildDefaults();

// Section this standard falls in by default, or null when the sheet doesn't cover it.
function defaultSectionFor(isNumber) {
    const k = scopeKey(isNumber);
    if (!k) return null;
    if (EXACT_MAP.has(k)) return EXACT_MAP.get(k);
    const lk = scopeKeyNoYear(k);
    return (lk && LOOSE_MAP.get(lk)) || null;
}

module.exports = { DEFAULT_SECTIONS, defaultSectionFor, scopeKey };
