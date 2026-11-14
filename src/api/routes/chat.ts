import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { parseRegionFromToken, tokenSplit } from '@/api/controllers/core.ts';
import { isSeedance25Model } from '@/api/consts/seedance25.ts';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';
import { selectToken, estimateCredits } from '@/lib/load-balancer.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)
            const { model, messages, stream } = request.body;
            const eligible = isSeedance25Model(model)
                ? (token: string) => parseRegionFromToken(token).isInternational : undefined;
            const tokens = tokenSplit(request.headers.authorization, eligible).filter(token => !eligible || eligible(token));
            if (eligible && tokens.length === 0) throw new Error('Seedance 2.5 模型需要 Dreamina 国际站账号');

            // 积分感知选择 token（含代理绑定）
            const isVideo = model && model.startsWith('jimeng-video');
            const estimatedCost = isVideo
              ? estimateCredits('video', { model })
              : estimateCredits('image', { model, resolution: '2k' });
            request.logDetails.estimatedCredits = estimatedCost;
            const sel = await selectToken(tokens, estimatedCost, isVideo ? 'highest' : 'drain-low');
            request.setLogAccount(sel.token);
            if (stream) {
                const stream = await createCompletionStream(messages, sel.proxyToken, model);
                return new Response(stream, {
                    type: "text/event-stream"
                });
            }
            else
                return await createCompletion(messages, sel.proxyToken, model);
        }

    }

}
