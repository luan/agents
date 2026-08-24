use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebRunInput {
    pub id: Option<String>,
    pub model: Option<String>,
    pub search_query: Option<Vec<SearchQuery>>,
    pub image_query: Option<Vec<SearchQuery>>,
    pub open: Option<Vec<OpenOperation>>,
    pub click: Option<Vec<ClickOperation>>,
    pub find: Option<Vec<FindOperation>>,
    pub screenshot: Option<Vec<ScreenshotOperation>>,
    pub finance: Option<Vec<FinanceOperation>>,
    pub weather: Option<Vec<WeatherOperation>>,
    pub sports: Option<Vec<SportsOperation>>,
    pub time: Option<Vec<TimeOperation>>,
    pub response_length: Option<ResponseLength>,
    pub settings: Option<UserSearchSettings>,
}

#[derive(Debug, Serialize)]
pub struct SearchRequest {
    pub id: String,
    pub model: String,
    pub commands: SearchCommands,
    pub settings: RequestSearchSettings,
}

#[derive(Debug, Serialize)]
pub struct SearchCommands {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_query: Option<Vec<SearchQuery>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_query: Option<Vec<SearchQuery>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<Vec<OpenOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click: Option<Vec<ClickOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub find: Option<Vec<FindOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<Vec<ScreenshotOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finance: Option<Vec<FinanceOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weather: Option<Vec<WeatherOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sports: Option<Vec<SportsOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<Vec<TimeOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_length: Option<ResponseLength>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchQuery {
    pub q: String,
    pub recency: Option<u64>,
    pub domains: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenOperation {
    pub ref_id: String,
    pub lineno: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClickOperation {
    pub ref_id: String,
    pub id: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FindOperation {
    pub ref_id: String,
    pub pattern: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScreenshotOperation {
    pub ref_id: String,
    pub pageno: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinanceOperation {
    pub ticker: String,
    pub r#type: FinanceType,
    pub market: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FinanceType {
    Equity,
    Fund,
    Crypto,
    Index,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WeatherOperation {
    pub location: String,
    pub start: Option<String>,
    pub duration: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SportsOperation {
    pub tool: Option<SportsTool>,
    pub r#fn: SportsFunction,
    pub league: SportsLeague,
    pub team: Option<String>,
    pub opponent: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub num_games: Option<u64>,
    pub locale: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SportsTool {
    Sports,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SportsFunction {
    Schedule,
    Standings,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SportsLeague {
    Nba,
    Wnba,
    Nfl,
    Nhl,
    Mlb,
    Epl,
    Ncaamb,
    Ncaawb,
    Ipl,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeOperation {
    pub utc_offset: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseLength {
    Short,
    Medium,
    Long,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserSearchSettings {
    pub search_context_size: Option<SearchContextSize>,
}

#[derive(Debug, Serialize)]
pub struct RequestSearchSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_context_size: Option<SearchContextSize>,
    pub allowed_callers: [&'static str; 1],
    pub external_web_access: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchContextSize {
    Low,
    Medium,
    High,
}

impl WebRunInput {
    pub fn into_request(self, default_model: String, default_id: String) -> SearchRequest {
        let settings = self.settings.unwrap_or(UserSearchSettings {
            search_context_size: None,
        });
        SearchRequest {
            id: self
                .id
                .filter(|id| !id.trim().is_empty())
                .unwrap_or(default_id),
            model: self
                .model
                .filter(|model| !model.trim().is_empty())
                .unwrap_or(default_model),
            commands: SearchCommands {
                search_query: self.search_query,
                image_query: self.image_query,
                open: self.open,
                click: self.click,
                find: self.find,
                screenshot: self.screenshot,
                finance: self.finance,
                weather: self.weather,
                sports: self.sports,
                time: self.time,
                response_length: self.response_length,
            },
            settings: RequestSearchSettings {
                search_context_size: settings.search_context_size,
                allowed_callers: ["direct"],
                external_web_access: true,
            },
        }
    }
}
