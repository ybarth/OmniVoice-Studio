"""Unit tests for dub_translate — no network, pure helpers + monkeypatched translator."""
import asyncio
import pytest


def test_translate_codes_cover_popular_iso():
    from api.routers.dub_translate import TRANSLATE_CODES
    popular = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'yue', 'ja', 'ko', 'ar', 'hi']
    for code in popular:
        assert code in TRANSLATE_CODES, f"{code} missing from TRANSLATE_CODES"
    assert TRANSLATE_CODES['yue'] == 'yue'


def test_flores_codes_cover_core_languages():
    from api.routers.dub_translate import FLORES_CODES
    for code in ('en', 'de', 'es', 'fr', 'hi', 'ja'):
        assert code in FLORES_CODES
    assert FLORES_CODES['yue'] == 'yue_Hant'


def test_resolve_source_lang_priority(monkeypatch):
    from api.routers import dub_translate

    class Req:
        def __init__(self, src=None, jid=None):
            self.source_lang = src
            self.job_id = jid

    # Explicit source_lang wins
    assert dub_translate._resolve_source_lang(Req(src='fr')) == 'fr'

    # Fall through to job-detected source_lang
    monkeypatch.setattr(
        dub_translate, '_get_job',
        lambda jid: {'source_lang': 'de'} if jid == 'j1' else None,
    )
    assert dub_translate._resolve_source_lang(Req(jid='j1')) == 'de'

    # No job, no explicit → default en
    assert dub_translate._resolve_source_lang(Req()) == 'en'
    assert dub_translate._resolve_source_lang(Req(jid='missing')) == 'en'


class _FakeSeg:
    def __init__(self, sid, text, target_lang=None):
        self.id = sid
        self.text = text
        self.target_lang = target_lang


class _FakeReq:
    def __init__(self, segments, target_lang, provider='google', source_lang=None):
        self.segments = segments
        self.target_lang = target_lang
        self.provider = provider
        self.source_lang = source_lang
        self.job_id = None


@pytest.mark.asyncio
async def test_google_path_passes_correct_target_code(monkeypatch):
    """GoogleTranslator constructed with the expected src/tgt codes for German."""
    from api.routers import dub_translate

    calls = []

    class FakeTranslator:
        def __init__(self, source=None, target=None, **kwargs):
            calls.append({'source': source, 'target': target})
        def translate(self, text):
            return f"[{calls[-1]['target']}]{text}"

    class FakeModule:
        GoogleTranslator = FakeTranslator
        DeepL = FakeTranslator
        MyMemoryTranslator = FakeTranslator
        MicrosoftTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Hello'), _FakeSeg('s2', 'World')],
        target_lang='de',
        provider='google',
        source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    assert resp['target_lang'] == 'de'
    assert resp['source_lang'] == 'en'
    texts = {t['id']: t['text'] for t in resp['translated']}
    assert texts['s1'] == '[de]Hello'
    assert texts['s2'] == '[de]World'
    # Each segment built a translator with de as target
    assert all(c['target'] == 'de' for c in calls)
    # Source came through as "en"
    assert any(c['source'] == 'en' for c in calls)


@pytest.mark.asyncio
async def test_google_path_accepts_auto_source_lang(monkeypatch):
    from api.routers import dub_translate

    calls = []

    class FakeTranslator:
        def __init__(self, source=None, target=None, **kwargs):
            calls.append({'source': source, 'target': target})
        def translate(self, text):
            return f"[{calls[-1]['source']}->{calls[-1]['target']}]{text}"

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Hello')],
        target_lang='es',
        provider='google',
        source_lang='auto',
    )
    resp = await dub_translate.dub_translate(req)

    assert resp['translated'][0]['text'] == '[auto->es]Hello'
    assert calls[0] == {'source': 'auto', 'target': 'es'}


@pytest.mark.asyncio
async def test_google_path_uses_seg_target_lang_override(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, source=None, target=None, **kwargs):
            self.target = target
        def translate(self, text):
            return f"[{self.target}]{text}"

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[
            _FakeSeg('s1', 'Hi', target_lang='bn'),  # per-segment override
            _FakeSeg('s2', 'Ok'),
        ],
        target_lang='de',
        provider='google',
        source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    texts = {t['id']: t['text'] for t in resp['translated']}
    assert texts['s1'] == '[bn]Hi'
    assert texts['s2'] == '[de]Ok'


@pytest.mark.asyncio
async def test_google_cantonese_translation_is_realized_before_response(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, source=None, target=None, **kwargs):
            self.target = target

        def translate(self, text):
            return '給我一杯水。'

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Give me a glass of water.')],
        target_lang='yue',
        provider='google',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)

    assert resp['translated'][0]['text'] == '畀杯水我。'
    assert resp['translated'][0]['cantonese_realized'] is True


@pytest.mark.asyncio
async def test_google_cantonese_translation_keeps_best_effort_when_rewrite_still_needed(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, source=None, target=None, **kwargs):
            self.target = target

        def translate(self, text):
            return '我們在香港說中文了。'

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'We spoke Chinese in Hong Kong.')],
        target_lang='yue',
        provider='google',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)
    row = resp['translated'][0]

    assert row['text'] == '我哋喺香港講中文了。'
    assert row['cantonese_realized'] is True
    assert row['needs_cantonese_rewrite'] is True
    assert 'error' not in row
    assert 'whole-sentence spoken Hong Kong rewrite' in row['cantonese_rewrite_warning']


@pytest.mark.asyncio
async def test_google_retries_then_falls_back_to_auto(monkeypatch):
    """Transient failure → retry → still fails → fall back to auto source."""
    from api.routers import dub_translate

    attempts = []

    class FakeTranslator:
        def __init__(self, source=None, target=None, **kwargs):
            self.source = source
            self.target = target
        def translate(self, text):
            attempts.append(self.source)
            if self.source != 'auto':
                raise RuntimeError('transient google error')
            return f"[auto:{self.target}]{text}"

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Hello')],
        target_lang='de', provider='google', source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    assert resp['translated'][0]['text'] == '[auto:de]Hello'
    assert 'error' not in resp['translated'][0]
    # explicit src tried at least once before auto
    assert attempts[0] == 'en'
    assert attempts[-1] == 'auto'


@pytest.mark.asyncio
async def test_google_reports_error_when_all_attempts_fail(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, **kwargs): pass
        def translate(self, text): raise RuntimeError('total failure')

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Hello')],
        target_lang='de', provider='google', source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    seg = resp['translated'][0]
    assert seg['text'] == 'Hello', 'original text preserved on failure'
    assert 'error' in seg
    assert 'total failure' in seg['error']


@pytest.mark.asyncio
async def test_empty_text_skipped(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, **kwargs): pass
        def translate(self, text): return '[xx]' + text

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', '  '), _FakeSeg('s2', 'hi')],
        target_lang='de', provider='google', source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    texts = {t['id']: t['text'] for t in resp['translated']}
    assert texts['s1'].strip() == ''  # untouched
    assert texts['s2'] == '[xx]hi'


@pytest.mark.asyncio
async def test_empty_translation_preserves_original(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, **kwargs): pass
        def translate(self, text): return ''  # always empty

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'hi')],
        target_lang='de', provider='google', source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    seg = resp['translated'][0]
    assert seg['text'] == 'hi'
    assert 'error' in seg


@pytest.mark.asyncio
async def test_deepl_uses_provider_specific_api_key(monkeypatch):
    from api.routers import dub_translate

    calls = []

    class FakeTranslator:
        def __init__(self, api_key=None, source=None, target=None, **kwargs):
            calls.append({'api_key': api_key, 'source': source, 'target': target})

        def translate(self, text):
            return f"[deepl]{text}"

    class FakeModule:
        DeeplTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)
    monkeypatch.setenv('TRANSLATE_API_KEY', 'generic-key')
    monkeypatch.setenv('DEEPL_API_KEY', 'deepl-key')

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Hello')],
        target_lang='de',
        provider='deepl',
        source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)

    assert resp['translated'][0]['text'] == '[deepl]Hello'
    assert calls[0]['api_key'] == 'deepl-key'


@pytest.mark.asyncio
async def test_hymt_provider_rejects_missing_model_without_loading(monkeypatch):
    from api.routers import dub_translate
    from services import translation_engines

    monkeypatch.setattr(translation_engines, "is_model_installed", lambda _engine_id: False)

    def fail_load(_model_id):
        raise AssertionError("missing HY-MT model should be rejected before loading")

    monkeypatch.setattr(dub_translate, "_load_local_translation_model", fail_load)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Out of sight')],
        target_lang='yue',
        provider='hymt-1.8b',
        source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)

    assert resp.status_code == 400
    assert "Download it from Models" in resp.body.decode()


@pytest.mark.asyncio
async def test_hymt_provider_translates_cantonese_with_selected_model(monkeypatch):
    from types import SimpleNamespace
    import sys
    from api.routers import dub_translate

    calls = {}

    class FakeTensor:
        shape = (1, 3)

        def to(self, device):
            calls['input_device'] = device
            return self

    class FakeTokenizer:
        @classmethod
        def from_pretrained(cls, model_id, **kwargs):
            calls['tokenizer_model_id'] = model_id
            calls['tokenizer_kwargs'] = kwargs
            return cls()

        def apply_chat_template(self, messages, **kwargs):
            calls['messages'] = messages
            calls['chat_template_kwargs'] = kwargs
            return FakeTensor()

        def decode(self, token_ids, **kwargs):
            calls['decoded_token_ids'] = list(token_ids)
            calls['decode_kwargs'] = kwargs
            return '睇唔到'

    class FakeModel:
        device = 'cpu'

        @classmethod
        def from_pretrained(cls, model_id, **kwargs):
            calls['model_id'] = model_id
            calls['model_kwargs'] = kwargs
            return cls()

        def to(self, device):
            self.device = device
            return self

        def generate(self, input_ids, **kwargs):
            calls['generate_kwargs'] = kwargs
            return [[1, 2, 3, 4, 5]]

    class FakeNoGrad:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        no_grad=lambda: FakeNoGrad(),
    )
    fake_transformers = SimpleNamespace(
        AutoTokenizer=FakeTokenizer,
        AutoModelForCausalLM=FakeModel,
    )
    monkeypatch.setitem(sys.modules, 'torch', fake_torch)
    monkeypatch.setitem(sys.modules, 'transformers', fake_transformers)
    monkeypatch.setenv('OMNIVOICE_UNLOAD_HYMT', '1')
    monkeypatch.setattr(dub_translate.translation_engines, 'is_model_installed', lambda _engine_id: True)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Out of sight')],
        target_lang='yue',
        provider='hymt-1.8b',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)

    assert resp['translated'] == [{'id': 's1', 'text': '睇唔到'}]
    assert resp['target_lang'] == 'yue'
    assert calls['model_id'] == 'tencent/HY-MT1.5-1.8B'
    assert calls['tokenizer_model_id'] == 'tencent/HY-MT1.5-1.8B'
    assert calls['model_kwargs']['local_files_only'] is True
    assert calls['tokenizer_kwargs']['local_files_only'] is True
    assert calls['decoded_token_ids'] == [4, 5]
    prompt = calls['messages'][0]['content']
    assert 'Cantonese' in prompt
    assert 'Hong Kong Cantonese' in prompt
    assert 'Mandarin' in prompt
    assert 'yue' in prompt
    assert 'without additional explanation' in prompt


@pytest.mark.asyncio
async def test_hymt_provider_generates_with_batch_encoding_inputs(monkeypatch):
    from types import SimpleNamespace
    import sys
    from api.routers import dub_translate

    calls = {}

    class FakeTensor:
        shape = (1, 3)

        def __getitem__(self, key):
            if isinstance(key, slice):
                return [4, 5]
            return [1, 2, 3][key]

    class FakeBatchEncoding(dict):
        def to(self, device):
            calls['batch_device'] = device
            return self

    class FakeTokenizer:
        def apply_chat_template(self, messages, **kwargs):
            calls['messages'] = messages
            calls['chat_template_kwargs'] = kwargs
            return FakeBatchEncoding({
                'input_ids': FakeTensor(),
                'attention_mask': FakeTensor(),
            })

        def decode(self, token_ids, **kwargs):
            calls['decoded_token_ids'] = list(token_ids)
            return '睇唔到'

    class FakeModel:
        device = 'cpu'

        def generate(self, *args, **kwargs):
            calls['generate_args'] = args
            calls['generate_kwargs'] = kwargs
            return [[1, 2, 3, 4, 5]]

    class FakeNoGrad:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_torch = SimpleNamespace(no_grad=lambda: FakeNoGrad())
    monkeypatch.setitem(sys.modules, 'torch', fake_torch)
    monkeypatch.setattr(
        dub_translate,
        '_load_local_translation_model',
        lambda _model_id: (FakeTokenizer(), FakeModel()),
    )
    monkeypatch.setattr(dub_translate.translation_engines, 'is_model_installed', lambda _engine_id: True)
    monkeypatch.setenv('OMNIVOICE_UNLOAD_HYMT', '1')

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Out of sight')],
        target_lang='yue',
        provider='hymt-7b',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)

    assert resp['translated'] == [{'id': 's1', 'text': '睇唔到'}]
    assert calls['generate_args'] == ()
    assert calls['generate_kwargs']['input_ids'] is not None
    assert calls['generate_kwargs']['attention_mask'] is not None
    assert calls['decoded_token_ids'] == [4, 5]


@pytest.mark.asyncio
async def test_hymt_provider_retries_when_cantonese_output_is_mandarin_like(monkeypatch):
    from types import SimpleNamespace
    import sys
    from api.routers import dub_translate

    calls = {'generate_count': 0, 'prompts': []}

    class FakeTensor:
        shape = (1, 3)

        def __getitem__(self, key):
            if isinstance(key, slice):
                return [4, 5]
            return [1, 2, 3][key]

    class FakeTokenizer:
        def apply_chat_template(self, messages, **kwargs):
            calls['prompts'].append(messages[0]['content'])
            return FakeTensor()

        def decode(self, token_ids, **kwargs):
            if calls['generate_count'] == 1:
                return '北京天气很好。'
            return '北京天氣好好呀。'

    class FakeModel:
        device = 'cpu'

        def generate(self, *args, **kwargs):
            calls['generate_count'] += 1
            return [[1, 2, 3, 4, 5]]

    class FakeNoGrad:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_torch = SimpleNamespace(no_grad=lambda: FakeNoGrad())
    monkeypatch.setitem(sys.modules, 'torch', fake_torch)
    monkeypatch.setattr(
        dub_translate,
        '_load_local_translation_model',
        lambda _model_id: (FakeTokenizer(), FakeModel()),
    )
    monkeypatch.setattr(dub_translate.translation_engines, 'is_model_installed', lambda _engine_id: True)
    monkeypatch.setenv('OMNIVOICE_UNLOAD_HYMT', '1')

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'I speak Chinese in Hong Kong.')],
        target_lang='yue',
        provider='hymt-7b',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)

    assert resp['translated'] == [{'id': 's1', 'text': '北京天氣好好呀。'}]
    assert calls['generate_count'] == 2
    assert 'previous attempt' in calls['prompts'][1]


@pytest.mark.asyncio
async def test_hymt_provider_realizes_written_cantonese_before_guard(monkeypatch):
    from types import SimpleNamespace
    import sys
    from api.routers import dub_translate

    calls = {'generate_count': 0}

    class FakeTensor:
        shape = (1, 3)

        def __getitem__(self, key):
            if isinstance(key, slice):
                return [4, 5]
            return [1, 2, 3][key]

    class FakeTokenizer:
        def apply_chat_template(self, messages, **kwargs):
            return FakeTensor()

        def decode(self, token_ids, **kwargs):
            return '給我一杯水。'

    class FakeModel:
        device = 'cpu'

        def generate(self, *args, **kwargs):
            calls['generate_count'] += 1
            return [[1, 2, 3, 4, 5]]

    class FakeNoGrad:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_torch = SimpleNamespace(no_grad=lambda: FakeNoGrad())
    monkeypatch.setitem(sys.modules, 'torch', fake_torch)
    monkeypatch.setattr(
        dub_translate,
        '_load_local_translation_model',
        lambda _model_id: (FakeTokenizer(), FakeModel()),
    )
    monkeypatch.setattr(dub_translate.translation_engines, 'is_model_installed', lambda _engine_id: True)
    monkeypatch.setenv('OMNIVOICE_UNLOAD_HYMT', '1')

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Give me a glass of water.')],
        target_lang='yue',
        provider='hymt-7b',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)

    assert resp['translated'][0]['text'] == '畀杯水我。'
    assert resp['translated'][0]['cantonese_realized'] is True
    assert calls['generate_count'] == 1


@pytest.mark.asyncio
async def test_hymt_provider_retries_when_rule_layer_needs_model_rewrite(monkeypatch):
    from types import SimpleNamespace
    import sys
    from api.routers import dub_translate

    calls = {'generate_count': 0, 'prompts': []}

    class FakeTensor:
        shape = (1, 3)

        def __getitem__(self, key):
            if isinstance(key, slice):
                return [4, 5]
            return [1, 2, 3][key]

    class FakeTokenizer:
        def apply_chat_template(self, messages, **kwargs):
            calls['prompts'].append(messages[0]['content'])
            return FakeTensor()

        def decode(self, token_ids, **kwargs):
            if calls['generate_count'] == 1:
                return '我們在香港說中文了。'
            if calls['generate_count'] == 2:
                return '我哋喺香港講中文了。'
            return '我哋喺香港講咗中文。'

    class FakeModel:
        device = 'cpu'

        def generate(self, *args, **kwargs):
            calls['generate_count'] += 1
            return [[1, 2, 3, 4, 5]]

    class FakeNoGrad:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_torch = SimpleNamespace(no_grad=lambda: FakeNoGrad())
    monkeypatch.setitem(sys.modules, 'torch', fake_torch)
    monkeypatch.setattr(
        dub_translate,
        '_load_local_translation_model',
        lambda _model_id: (FakeTokenizer(), FakeModel()),
    )
    monkeypatch.setattr(dub_translate.translation_engines, 'is_model_installed', lambda _engine_id: True)
    monkeypatch.setenv('OMNIVOICE_UNLOAD_HYMT', '1')

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'We spoke Chinese in Hong Kong.')],
        target_lang='yue',
        provider='hymt-7b',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)

    assert resp['translated'] == [{'id': 's1', 'text': '我哋喺香港講咗中文。'}]
    assert calls['generate_count'] == 3
    assert 'previous attempt' in calls['prompts'][1]
    assert 'whole-sentence spoken Hong Kong Cantonese' in calls['prompts'][2]
    assert '我哋喺香港講中文了。' in calls['prompts'][2]


@pytest.mark.asyncio
async def test_hymt_provider_returns_best_effort_when_rewrite_still_needed(monkeypatch):
    from types import SimpleNamespace
    import sys
    from api.routers import dub_translate

    calls = {'generate_count': 0, 'prompts': []}

    class FakeTensor:
        shape = (1, 3)

        def __getitem__(self, key):
            if isinstance(key, slice):
                return [4, 5]
            return [1, 2, 3][key]

    class FakeTokenizer:
        def apply_chat_template(self, messages, **kwargs):
            calls['prompts'].append(messages[0]['content'])
            return FakeTensor()

        def decode(self, token_ids, **kwargs):
            if calls['generate_count'] == 1:
                return '我們在香港說中文了。'
            return '我哋喺香港講中文了。'

    class FakeModel:
        device = 'cpu'

        def generate(self, *args, **kwargs):
            calls['generate_count'] += 1
            return [[1, 2, 3, 4, 5]]

    class FakeNoGrad:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_torch = SimpleNamespace(no_grad=lambda: FakeNoGrad())
    monkeypatch.setitem(sys.modules, 'torch', fake_torch)
    monkeypatch.setattr(
        dub_translate,
        '_load_local_translation_model',
        lambda _model_id: (FakeTokenizer(), FakeModel()),
    )
    monkeypatch.setattr(dub_translate.translation_engines, 'is_model_installed', lambda _engine_id: True)
    monkeypatch.setenv('OMNIVOICE_UNLOAD_HYMT', '1')

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'We spoke Chinese in Hong Kong.')],
        target_lang='yue',
        provider='hymt-7b',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)
    row = resp['translated'][0]

    assert row['text'] == '我哋喺香港講中文了。'
    assert row['needs_cantonese_rewrite'] is True
    assert 'error' not in row
    assert 'whole-sentence spoken Hong Kong rewrite' in row['cantonese_rewrite_warning']
    assert calls['generate_count'] == 3


@pytest.mark.asyncio
async def test_openai_provider_rewrites_cantonese_draft_after_translation_retries(monkeypatch):
    import io
    import json
    from api.routers import dub_translate

    calls = []
    responses = [
        {"choices": [{"message": {"content": "我們在香港說中文了。"}}]},
        {"choices": [{"message": {"content": "我哋喺香港講中文了。"}}]},
        {"choices": [{"message": {"content": "我哋喺香港講咗中文。"}}]},
    ]

    class FakeHTTPResponse:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return io.BytesIO(json.dumps(self.body).encode("utf-8"))

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_urlopen(request, timeout=None):
        payload = json.loads(request.data.decode("utf-8"))
        calls.append(payload)
        return FakeHTTPResponse(responses.pop(0))

    monkeypatch.setattr(dub_translate.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'We spoke Chinese in Hong Kong.')],
        target_lang='yue',
        provider='openai',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)

    assert resp['translated'] == [{'id': 's1', 'text': '我哋喺香港講咗中文。'}]
    assert len(calls) == 3
    rewrite_system = calls[2]['messages'][0]['content']
    rewrite_user = calls[2]['messages'][1]['content']
    assert 'whole-sentence spoken Hong Kong Cantonese' in rewrite_system
    assert '我哋喺香港講中文了。' in rewrite_user


@pytest.mark.asyncio
async def test_openai_provider_returns_best_effort_when_cantonese_rewrite_still_needs_work(monkeypatch):
    import io
    import json
    from api.routers import dub_translate

    calls = []
    responses = [
        {"choices": [{"message": {"content": "我們在香港說中文了。"}}]},
        {"choices": [{"message": {"content": "我哋喺香港講中文了。"}}]},
        {"choices": [{"message": {"content": "我哋喺香港講中文了。"}}]},
    ]

    class FakeHTTPResponse:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return io.BytesIO(json.dumps(self.body).encode("utf-8"))

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_urlopen(request, timeout=None):
        payload = json.loads(request.data.decode("utf-8"))
        calls.append(payload)
        return FakeHTTPResponse(responses.pop(0))

    monkeypatch.setattr(dub_translate.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'We spoke Chinese in Hong Kong.')],
        target_lang='yue',
        provider='openai',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)
    row = resp['translated'][0]

    assert row['text'] == '我哋喺香港講中文了。'
    assert row['needs_cantonese_rewrite'] is True
    assert 'error' not in row
    assert 'whole-sentence spoken Hong Kong rewrite' in row['cantonese_rewrite_warning']
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_openai_provider_retries_when_cantonese_output_is_mandarin_like(monkeypatch):
    import io
    import json
    from api.routers import dub_translate

    calls = []
    responses = [
        {"choices": [{"message": {"content": "北京天气很好。"}}]},
        {"choices": [{"message": {"content": "北京天氣好好呀。"}}]},
    ]

    class FakeHTTPResponse:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return io.BytesIO(json.dumps(self.body).encode("utf-8"))

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_urlopen(request, timeout=None):
        payload = json.loads(request.data.decode("utf-8"))
        calls.append(payload)
        return FakeHTTPResponse(responses.pop(0))

    monkeypatch.setattr(dub_translate.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'I speak Chinese in Hong Kong.')],
        target_lang='yue',
        provider='openai',
        source_lang='en',
    )

    resp = await dub_translate.dub_translate(req)

    assert resp['translated'] == [{'id': 's1', 'text': '北京天氣好好呀。'}]
    assert len(calls) == 2
    first_system = calls[0]['messages'][0]['content']
    second_system = calls[1]['messages'][0]['content']
    assert 'Hong Kong Cantonese' in first_system
    assert 'Mandarin' in first_system
    assert 'previous attempt' in second_system
