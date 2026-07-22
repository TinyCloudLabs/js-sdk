;; adder — pure, zero-permission compute demo fixture (no host imports).
;;
;; Demonstrates the "layer (a) only" case of compute-service.md §6.1: an
;; invoker holding nothing but `tinycloud.compute/execute` can run this, and
;; the execution manifest shows ZERO host calls (empty granted/exercised
;; sets) because the guest never touches the "tinycloud" import surface at
;; all.
;;
;; Behavior: sums every run of ASCII decimal digits found in the input
;; bytes. For the canonical input `{"numbers":[1,2,3]}` this sums 1+2+3=6,
;; returning `{"sum":6}`. This is real, input-driven arithmetic (not a
;; canned response) scoped to non-negative integers with no actual JSON
;; parsing (no structural awareness of the "numbers" key or array syntax —
;; any digit run in the byte stream is summed). That's an intentional,
;; documented simplification for a hand-written WAT demo fixture; a
;; production guest would compile from a real language with a real parser.
;;
;; Guest ABI (same shape as compute_fixture.wat / specs/compute-service.md
;; Appendix A): alloc(len)->ptr bump allocator, run(ptr,len)->(ptr,len).
(module
  (memory (export "memory") 1)

  (data (i32.const 0x0010) "{\"sum\":")
  (data (i32.const 0x0020) "}")

  (global $hp (mut i32) (i32.const 0x0100))

  (func $alloc (export "alloc") (param $len i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $hp))
    (global.set $hp
      (i32.and
        (i32.add (i32.add (global.get $hp) (local.get $len)) (i32.const 7))
        (i32.const -8)))
    (local.get $p))

  (func $memcpy (param $dst i32) (param $src i32) (param $len i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (i32.store8 (i32.add (local.get $dst) (local.get $i))
                    (i32.load8_u (i32.add (local.get $src) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop))))

  ;; write_uint(dst, val) -> bytes written (unsigned decimal ASCII).
  (func $write_uint (param $dst i32) (param $val i32) (result i32)
    (local $tmp i32) (local $len i32) (local $rem i32) (local $i i32)
    (if (i32.eqz (local.get $val))
      (then
        (i32.store8 (local.get $dst) (i32.const 48))
        (return (i32.const 1))))
    (local.set $tmp (call $alloc (i32.const 16)))
    (local.set $len (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.eqz (local.get $val)))
        (local.set $rem (i32.rem_u (local.get $val) (i32.const 10)))
        (i32.store8 (i32.add (local.get $tmp) (local.get $len)) (i32.add (local.get $rem) (i32.const 48)))
        (local.set $len (i32.add (local.get $len) (i32.const 1)))
        (local.set $val (i32.div_u (local.get $val) (i32.const 10)))
        (br $loop)))
    (local.set $i (i32.const 0))
    (block $done2
      (loop $loop2
        (br_if $done2 (i32.ge_u (local.get $i) (local.get $len)))
        (i32.store8
          (i32.add (local.get $dst) (local.get $i))
          (i32.load8_u (i32.add (local.get $tmp) (i32.sub (i32.sub (local.get $len) (local.get $i)) (i32.const 1)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop2)))
    (local.get $len))

  (func (export "run") (param $in_ptr i32) (param $in_len i32) (result i32 i32)
    (local $i i32) (local $c i32) (local $cur i32) (local $sum i32) (local $insum i32)
    (local $out i32) (local $sumlen i32) (local $w i32)
    (local.set $i (i32.const 0))
    (local.set $sum (i32.const 0))
    (local.set $cur (i32.const 0))
    (local.set $insum (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $in_len)))
        (local.set $c (i32.load8_u (i32.add (local.get $in_ptr) (local.get $i))))
        (if (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57)))
          (then
            (local.set $cur (i32.add (i32.mul (local.get $cur) (i32.const 10)) (i32.sub (local.get $c) (i32.const 48))))
            (local.set $insum (i32.const 1)))
          (else
            (if (local.get $insum)
              (then
                (local.set $sum (i32.add (local.get $sum) (local.get $cur)))
                (local.set $cur (i32.const 0))
                (local.set $insum (i32.const 0))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (if (local.get $insum)
      (then (local.set $sum (i32.add (local.get $sum) (local.get $cur)))))

    (local.set $out (call $alloc (i32.const 32)))
    (local.set $w (local.get $out))
    (call $memcpy (local.get $w) (i32.const 0x0010) (i32.const 7))
    (local.set $w (i32.add (local.get $w) (i32.const 7)))
    (local.set $sumlen (call $write_uint (local.get $w) (local.get $sum)))
    (local.set $w (i32.add (local.get $w) (local.get $sumlen)))
    (call $memcpy (local.get $w) (i32.const 0x0020) (i32.const 1))
    (local.set $w (i32.add (local.get $w) (i32.const 1)))
    (return (local.get $out) (i32.sub (local.get $w) (local.get $out)))))
