use std::hash::pedersen_hash;
global NULLIFIER_DOMAIN: Field = 0x70726f6f7665;
// Off-circuit helper for the registry: computes leaf, node and nullifier hashes with exactly
// the circuit's hash function, executed (not proved) with noir_js.
fn main(item: [Field; 6], left: Field, right: Field) -> pub (Field, Field, Field) {
    (pedersen_hash(item), pedersen_hash([left, right]), pedersen_hash([item[0], NULLIFIER_DOMAIN]))
}
