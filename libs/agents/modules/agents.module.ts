import { Module, forwardRef } from '@nestjs/common';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';

import { BusinessRulesValidationAgentUseCase } from '../application/use-cases/business-rules-validation-agent.use-case';
import { ConversationAgentUseCase } from '../application/use-cases/conversation-agent.use-case';
import { ContextEvidenceAgentProvider } from '../infrastructure/services/kodus-flow/contextEvidenceAgent.provider';
import { BusinessRulesValidationAgentProvider } from '../infrastructure/services/kodus-flow/businessRulesValidationAgent';
import { ConversationAgentProvider } from '../infrastructure/services/kodus-flow/conversationAgent';
import { LLMModule } from '@kodus/kodus-common/llm';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { SkillRunnerService } from '../infrastructure/services/skill-runner.service';

@Module({
    imports: [
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => ParametersModule),
        LLMModule,
        forwardRef(() => McpCoreModule),
    ],
    providers: [
        BusinessRulesValidationAgentUseCase,
        ConversationAgentUseCase,
        ContextEvidenceAgentProvider,
        BusinessRulesValidationAgentProvider,
        ConversationAgentProvider,
        SkillLoaderService,
        SkillRunnerService,
    ],
    exports: [
        BusinessRulesValidationAgentUseCase,
        ConversationAgentUseCase,
        ContextEvidenceAgentProvider,
        BusinessRulesValidationAgentProvider,
        ConversationAgentProvider,
        SkillLoaderService,
        SkillRunnerService,
    ],
})
export class AgentsModule {}
