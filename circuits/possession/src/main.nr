use std::hash::pedersen_hash;

global DEPTH: u32 = 8;
global NULLIFIER_DOMAIN: Field = 0x70726f6f7665; // "proove"

// Leaf = H(secret, category, edition_no, edition_size, measure, cert_year)
fn leaf(secret: Field, category: Field, edition_no: Field, edition_size: Field, measure: Field, year: Field) -> Field {
    pedersen_hash([secret, category, edition_no, edition_size, measure, year])
}

// Proves: "I know the secret of an item certified in the registry tree with this root,
// whose public attributes satisfy the listing", without revealing which item.
// Returns the item's nullifier: the same item always yields the same value, so double listings show up.
fn main(
    secret: Field,
    edition_no: u32,
    measure: u64,
    cert_year: u32,
    path: [Field; DEPTH],
    index_bits: [bool; DEPTH],
    root: pub Field,
    category: pub Field,
    edition_size: pub u32,
    min_measure: pub u64,
    min_year: pub u32,
    listing: pub Field,
) -> pub Field {
    assert(edition_no >= 1, "edition number starts at 1");
    assert(edition_no <= edition_size, "edition number outside the edition");
    assert(measure >= min_measure, "item below the listed minimum");
    assert(cert_year >= min_year, "certified too early");
    let mut node = leaf(secret, category, edition_no as Field, edition_size as Field, measure as Field, cert_year as Field);
    for i in 0..DEPTH {
        node = if index_bits[i] { pedersen_hash([path[i], node]) } else { pedersen_hash([node, path[i]]) };
    }
    assert(node == root, "item is not in the registry");
    assert(listing != 0, "proof must be bound to a listing");
    pedersen_hash([secret, NULLIFIER_DOMAIN])
}
