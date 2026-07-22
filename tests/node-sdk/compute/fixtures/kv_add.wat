;; kv_add — stateful compute demo fixture, exercising the two-layer
;; permissioning model end to end (compute-service.md §6).
;;
;; Input: `{"key":"<path>","amount":<uint>}`. Behavior: storage_get(key) ->
;; parse the stored value as an unsigned integer (missing/null/empty value
;; treated as 0) -> add `amount` -> storage_put(key, newValue) -> returns
;; `{"previous":<old>,"new":<new>}`.
;;
;; The routine reads/writes `key` under its OWN deploy-time `D_fn` grant —
;; the invoker of `compute/execute` needs (and gets) no kv capability of its
;; own. If `key` is outside the D_fn's grant, storage_get returns the A.4
;; denial envelope (`"ok":false`, op not performed); this guest detects that
;; and returns `{"denied":"tinycloud.kv/get","key":"<key>"}` WITHOUT ever
;; calling storage_put (no mutation on a denied read) — same handling if
;; storage_put itself is denied (`tinycloud.kv/put`).
;;
;; Extraction is marker-based (find `"key":"` / `"amount":` / `"value":` and
;; scan from there), not a general JSON parser — a documented simplification
;; for a hand-written WAT demo fixture. It assumes the caller sends compact
;; JSON (no whitespace after `:`), which is what `JSON.stringify` produces.
;;
;; Guest ABI (same shape as compute_fixture.wat / adder.wat): alloc(len)->ptr
;; bump allocator, run(ptr,len)->(ptr,len). Host imports used: storage_get,
;; storage_put (storage_del, sql_query are imported per the fixed four-import
;; "tinycloud" surface but never called by this guest).
(module
  (import "tinycloud" "storage_get" (func $storage_get (param i32 i32) (result i32 i32)))
  (import "tinycloud" "storage_put" (func $storage_put (param i32 i32) (result i32 i32)))
  (import "tinycloud" "storage_del" (func $storage_del (param i32 i32) (result i32 i32)))
  (import "tinycloud" "sql_query"   (func $sql_query   (param i32 i32) (result i32 i32)))

  (memory (export "memory") 2)

  ;; --- static markers / literals (offsets computed to avoid overlap; see
  ;; scratch layout notes in this branch's PR description) ---
  (data (i32.const 0x0020) "\"key\":\"")          ;; KEY_MARKER        len 7
  (data (i32.const 0x0028) "\"amount\":")          ;; AMOUNT_MARKER     len 9
  (data (i32.const 0x0038) "\"value\":")           ;; VALUE_MARKER      len 8
  (data (i32.const 0x0040) "\"ok\":false")         ;; OK_FALSE          len 10
  (data (i32.const 0x0050) "{\"key\":\"")          ;; GET_PREFIX        len 8
  (data (i32.const 0x0058) "\"}")                  ;; QUOTE_CLOSE_BRACE len 2
  (data (i32.const 0x0060) "\",\"value\":\"")      ;; PUT_MID           len 11
  (data (i32.const 0x0070) "{\"previous\":")        ;; RESULT_PREFIX     len 12
  (data (i32.const 0x0080) ",\"new\":")             ;; RESULT_MID        len 7
  (data (i32.const 0x0088) "}")                     ;; RESULT_SUFFIX     len 1
  (data (i32.const 0x0090) "{\"denied\":\"tinycloud.kv/get\",\"key\":\"")  ;; DENY_GET len 36
  (data (i32.const 0x00b8) "{\"denied\":\"tinycloud.kv/put\",\"key\":\"")  ;; DENY_PUT len 36

  (global $hp (mut i32) (i32.const 0x0200))

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

  (func $eq (param $a i32) (param $alen i32) (param $b i32) (param $blen i32) (result i32)
    (local $i i32)
    (if (i32.ne (local.get $alen) (local.get $blen))
      (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $alen)))
        (if (i32.ne
              (i32.load8_u (i32.add (local.get $a) (local.get $i)))
              (i32.load8_u (i32.add (local.get $b) (local.get $i))))
          (then (return (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 1))

  ;; contains(hay, haylen, needle, needlelen) -> 1 if needle occurs in hay.
  (func $contains (param $hay i32) (param $haylen i32) (param $ndl i32) (param $ndllen i32) (result i32)
    (local $i i32) (local $limit i32)
    (if (i32.gt_u (local.get $ndllen) (local.get $haylen))
      (then (return (i32.const 0))))
    (local.set $limit (i32.sub (local.get $haylen) (local.get $ndllen)))
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.gt_u (local.get $i) (local.get $limit)))
        (if (call $eq
              (i32.add (local.get $hay) (local.get $i)) (local.get $ndllen)
              (local.get $ndl) (local.get $ndllen))
          (then (return (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0))

  ;; find(hay, haylen, needle, needlelen) -> index of first match, or -1.
  (func $find (param $hay i32) (param $haylen i32) (param $ndl i32) (param $ndllen i32) (result i32)
    (local $i i32) (local $limit i32)
    (if (i32.gt_u (local.get $ndllen) (local.get $haylen))
      (then (return (i32.const -1))))
    (local.set $limit (i32.sub (local.get $haylen) (local.get $ndllen)))
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.gt_u (local.get $i) (local.get $limit)))
        (if (call $eq
              (i32.add (local.get $hay) (local.get $i)) (local.get $ndllen)
              (local.get $ndl) (local.get $ndllen))
          (then (return (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const -1))

  ;; find_char(hay, haylen, start, ch) -> index of first `ch` at/after
  ;; `start`, or -1.
  (func $find_char (param $hay i32) (param $haylen i32) (param $start i32) (param $ch i32) (result i32)
    (local $i i32)
    (local.set $i (local.get $start))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $haylen)))
        (if (i32.eq (i32.load8_u (i32.add (local.get $hay) (local.get $i))) (local.get $ch))
          (then (return (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const -1))

  ;; parse_uint(p, maxlen) -> value; scans decimal digits from p, stopping at
  ;; the first non-digit byte or after maxlen bytes. Zero-length -> 0.
  (func $parse_uint (param $p i32) (param $maxlen i32) (result i32)
    (local $v i32) (local $i i32) (local $c i32)
    (local.set $v (i32.const 0))
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $maxlen)))
        (local.set $c (i32.load8_u (i32.add (local.get $p) (local.get $i))))
        (br_if $done (i32.lt_u (local.get $c) (i32.const 48)))
        (br_if $done (i32.gt_u (local.get $c) (i32.const 57)))
        (local.set $v (i32.add (i32.mul (local.get $v) (i32.const 10)) (i32.sub (local.get $c) (i32.const 48))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $v))

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

  ;; build_denied(label_off, label_len, key_ptr, key_len) -> (ptr, len)
  ;; `{"denied":"tinycloud.kv/<get|put>","key":"<key>"}`.
  (func $build_denied (param $label i32) (param $labellen i32) (param $key i32) (param $keylen i32) (result i32 i32)
    (local $out i32) (local $w i32)
    (local.set $out (call $alloc (i32.add (i32.add (local.get $labellen) (local.get $keylen)) (i32.const 2))))
    (local.set $w (local.get $out))
    (call $memcpy (local.get $w) (local.get $label) (local.get $labellen))
    (local.set $w (i32.add (local.get $w) (local.get $labellen)))
    (call $memcpy (local.get $w) (local.get $key) (local.get $keylen))
    (local.set $w (i32.add (local.get $w) (local.get $keylen)))
    (call $memcpy (local.get $w) (i32.const 0x0058) (i32.const 2)) ;; QUOTE_CLOSE_BRACE
    (local.set $w (i32.add (local.get $w) (i32.const 2)))
    (local.get $out) (i32.sub (local.get $w) (local.get $out)))

  (func (export "run") (param $in_ptr i32) (param $in_len i32) (result i32 i32)
    (local $key_marker i32) (local $key_start i32) (local $key_end i32) (local $key_len i32) (local $key_ptr i32)
    (local $amt_marker i32) (local $amt_start i32) (local $amount i32)
    (local $get_req i32) (local $get_req_len i32) (local $w i32)
    (local $get_resp_ptr i32) (local $get_resp_len i32)
    (local $value_marker i32) (local $value_start i32) (local $vbyte i32)
    (local $val_start2 i32) (local $val_end i32) (local $val_len i32)
    (local $previous i32) (local $newval i32)
    (local $newval_buf i32) (local $newval_len i32) (local $prev_buf i32) (local $prev_len i32)
    (local $put_req i32) (local $put_req_len i32)
    (local $put_resp_ptr i32) (local $put_resp_len i32)
    (local $result i32) (local $result_len i32)

    ;; --- extract "key" ---
    (local.set $key_marker (call $find (local.get $in_ptr) (local.get $in_len) (i32.const 0x0020) (i32.const 7)))
    (local.set $key_start (i32.add (local.get $key_marker) (i32.const 7)))
    (local.set $key_end (call $find_char (local.get $in_ptr) (local.get $in_len) (local.get $key_start) (i32.const 34)))
    (local.set $key_len (i32.sub (local.get $key_end) (local.get $key_start)))
    (local.set $key_ptr (i32.add (local.get $in_ptr) (local.get $key_start)))

    ;; --- extract "amount" ---
    (local.set $amt_marker (call $find (local.get $in_ptr) (local.get $in_len) (i32.const 0x0028) (i32.const 9)))
    (local.set $amt_start (i32.add (local.get $amt_marker) (i32.const 9)))
    (local.set $amount
      (call $parse_uint
        (i32.add (local.get $in_ptr) (local.get $amt_start))
        (i32.sub (local.get $in_len) (local.get $amt_start))))

    ;; --- build + send storage_get {"key":"<key>"} ---
    (local.set $get_req (call $alloc (i32.add (i32.add (i32.const 8) (local.get $key_len)) (i32.const 2))))
    (local.set $w (local.get $get_req))
    (call $memcpy (local.get $w) (i32.const 0x0050) (i32.const 8)) ;; GET_PREFIX
    (local.set $w (i32.add (local.get $w) (i32.const 8)))
    (call $memcpy (local.get $w) (local.get $key_ptr) (local.get $key_len))
    (local.set $w (i32.add (local.get $w) (local.get $key_len)))
    (call $memcpy (local.get $w) (i32.const 0x0058) (i32.const 2)) ;; QUOTE_CLOSE_BRACE
    (local.set $w (i32.add (local.get $w) (i32.const 2)))
    (local.set $get_req_len (i32.sub (local.get $w) (local.get $get_req)))

    (call $storage_get (local.get $get_req) (local.get $get_req_len))
    (local.set $get_resp_len) (local.set $get_resp_ptr)

    (if (call $contains (local.get $get_resp_ptr) (local.get $get_resp_len) (i32.const 0x0040) (i32.const 10))
      (then
        (call $build_denied (i32.const 0x0090) (i32.const 36) (local.get $key_ptr) (local.get $key_len))
        (return)))

    ;; --- parse "value" out of the get response ---
    (local.set $value_marker (call $find (local.get $get_resp_ptr) (local.get $get_resp_len) (i32.const 0x0038) (i32.const 8)))
    (local.set $value_start (i32.add (local.get $value_marker) (i32.const 8)))
    (local.set $vbyte (i32.load8_u (i32.add (local.get $get_resp_ptr) (local.get $value_start))))
    (if (i32.eq (local.get $vbyte) (i32.const 110)) ;; 'n' of null
      (then (local.set $previous (i32.const 0)))
      (else
        (local.set $val_start2 (i32.add (local.get $value_start) (i32.const 1)))
        (local.set $val_end
          (call $find_char (local.get $get_resp_ptr) (local.get $get_resp_len) (local.get $val_start2) (i32.const 34)))
        (local.set $val_len (i32.sub (local.get $val_end) (local.get $val_start2)))
        (local.set $previous
          (call $parse_uint (i32.add (local.get $get_resp_ptr) (local.get $val_start2)) (local.get $val_len)))))

    (local.set $newval (i32.add (local.get $previous) (local.get $amount)))
    (local.set $newval_buf (call $alloc (i32.const 16)))
    (local.set $newval_len (call $write_uint (local.get $newval_buf) (local.get $newval)))

    ;; --- build + send storage_put {"key":"<key>","value":"<newval>"} ---
    (local.set $put_req
      (call $alloc
        (i32.add (i32.add (i32.add (i32.const 8) (local.get $key_len)) (i32.const 11))
                 (i32.add (local.get $newval_len) (i32.const 2)))))
    (local.set $w (local.get $put_req))
    (call $memcpy (local.get $w) (i32.const 0x0050) (i32.const 8)) ;; GET_PREFIX ({"key":")
    (local.set $w (i32.add (local.get $w) (i32.const 8)))
    (call $memcpy (local.get $w) (local.get $key_ptr) (local.get $key_len))
    (local.set $w (i32.add (local.get $w) (local.get $key_len)))
    (call $memcpy (local.get $w) (i32.const 0x0060) (i32.const 11)) ;; PUT_MID
    (local.set $w (i32.add (local.get $w) (i32.const 11)))
    (call $memcpy (local.get $w) (local.get $newval_buf) (local.get $newval_len))
    (local.set $w (i32.add (local.get $w) (local.get $newval_len)))
    (call $memcpy (local.get $w) (i32.const 0x0058) (i32.const 2)) ;; QUOTE_CLOSE_BRACE
    (local.set $w (i32.add (local.get $w) (i32.const 2)))
    (local.set $put_req_len (i32.sub (local.get $w) (local.get $put_req)))

    (call $storage_put (local.get $put_req) (local.get $put_req_len))
    (local.set $put_resp_len) (local.set $put_resp_ptr)

    (if (call $contains (local.get $put_resp_ptr) (local.get $put_resp_len) (i32.const 0x0040) (i32.const 10))
      (then
        (call $build_denied (i32.const 0x00b8) (i32.const 36) (local.get $key_ptr) (local.get $key_len))
        (return)))

    ;; --- build result {"previous":<p>,"new":<n>} ---
    (local.set $prev_buf (call $alloc (i32.const 16)))
    (local.set $prev_len (call $write_uint (local.get $prev_buf) (local.get $previous)))
    (local.set $result
      (call $alloc
        (i32.add (i32.add (i32.const 12) (local.get $prev_len))
                 (i32.add (i32.const 7) (i32.add (local.get $newval_len) (i32.const 1))))))
    (local.set $w (local.get $result))
    (call $memcpy (local.get $w) (i32.const 0x0070) (i32.const 12)) ;; RESULT_PREFIX
    (local.set $w (i32.add (local.get $w) (i32.const 12)))
    (call $memcpy (local.get $w) (local.get $prev_buf) (local.get $prev_len))
    (local.set $w (i32.add (local.get $w) (local.get $prev_len)))
    (call $memcpy (local.get $w) (i32.const 0x0080) (i32.const 7)) ;; RESULT_MID
    (local.set $w (i32.add (local.get $w) (i32.const 7)))
    (call $memcpy (local.get $w) (local.get $newval_buf) (local.get $newval_len))
    (local.set $w (i32.add (local.get $w) (local.get $newval_len)))
    (call $memcpy (local.get $w) (i32.const 0x0088) (i32.const 1)) ;; RESULT_SUFFIX
    (local.set $w (i32.add (local.get $w) (i32.const 1)))
    (local.set $result_len (i32.sub (local.get $w) (local.get $result)))
    (return (local.get $result) (local.get $result_len))))
